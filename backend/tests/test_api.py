import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import main
from app.telemetry import TelemetryStore, calculate_stress_metrics


class AnalysisApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.store = TelemetryStore(Path(self.temporary_directory.name) / "telemetry.sqlite3")
        self.store_patch = patch.object(main, "telemetry_store", self.store)
        self.store_patch.start()
        self.client = TestClient(main.app)

    def tearDown(self):
        self.client.close()
        self.store_patch.stop()
        self.temporary_directory.cleanup()

    def test_health_endpoint_reports_service_status(self):
        response = self.client.get("/api/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok", "service": "BeamLab Analysis API"})

    def test_material_presets_endpoint_returns_cited_screening_values(self):
        response = self.client.get("/api/materials")

        self.assertEqual(response.status_code, 200)
        presets = {material["id"]: material for material in response.json()}
        self.assertEqual(
            set(presets),
            {"steel_a36", "aluminum_6061_t6", "titanium_grade_5", "structural_timber"},
        )
        self.assertEqual(presets["steel_a36"]["yield_strength_mpa"], 250.0)
        self.assertEqual(presets["aluminum_6061_t6"]["youngs_modulus_gpa"], 68.9)
        self.assertEqual(presets["titanium_grade_5"]["yield_strength_mpa"], 880.0)
        self.assertEqual(presets["structural_timber"]["strength_kind"], "bending-reference")
        for material in presets.values():
            with self.subTest(material=material["id"]):
                self.assertTrue(material["source_name"])
                self.assertTrue(material["source_url"].startswith("https://"))
                self.assertTrue(material["strength_basis"])

    def test_analyze_endpoint_returns_full_beam_response(self):
        response = self.client.post("/api/analyze", json=self.valid_beam_request())

        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertEqual(result["station_count"], 101)
        self.assertEqual(len(result["points"]), 101)
        self.assertAlmostEqual(result["reactions"]["RA_kN"], 10.0)
        self.assertAlmostEqual(result["summary"]["max_abs_bending_stress_MPa"], 60.0, places=2)

    def test_invalid_beam_requests_return_validation_errors(self):
        invalid_requests = (
            ({**self.valid_beam_request(), "length_m": 0.0},),
            ({**self.valid_beam_request(), "intervals": 99},),
            ({**self.valid_beam_request(), "support_b_m": 0.0},),
            ({
                **self.valid_beam_request(),
                "loads": [{"type": "point", "P": 10.0, "x": 7.0}],
            },),
            ({
                **self.valid_beam_request(),
                "loads": [{"type": "point", "P": 10.0, "x": 1.0, "unexpected": True}],
            },),
            ({
                **self.valid_beam_request(),
                "loads": [{"type": "unknown", "x": 1.0}],
            },),
            ({
                **self.valid_beam_request(),
                "loads": [{"type": "moment", "M": 10.0, "x": 3.0, "extra": 1}],
            },),
            ({
                **self.valid_beam_request(),
                "loads": [{"type": "udl", "w1": 1.0, "w2": 2.0, "x1": 0.0, "x2": 7.0}],
            },),
        )
        for (request,) in invalid_requests:
            with self.subTest(request=request):
                response = self.client.post("/api/analyze", json=request)
                self.assertEqual(response.status_code, 422)

    def test_telemetry_endpoints_return_empty_and_persisted_history(self):
        self.assertEqual(self.client.get("/api/telemetry/latest").json(), None)
        self.assertEqual(self.client.get("/api/telemetry/history").json(), {"frames": []})

        for sequence in (1, 2, 3):
            self.store.insert(calculate_stress_metrics(100.0, 0.0, 0.0, sequence=sequence))
        latest = self.client.get("/api/telemetry/latest")
        history = self.client.get("/api/telemetry/history?limit=2")

        self.assertEqual(latest.status_code, 200)
        self.assertEqual(latest.json()["sequence"], 3)
        self.assertEqual([frame["sequence"] for frame in history.json()["frames"]], [2, 3])

    def test_telemetry_history_limit_is_validated(self):
        for limit in (0, 1001, "invalid"):
            with self.subTest(limit=limit):
                self.assertEqual(
                    self.client.get(f"/api/telemetry/history?limit={limit}").status_code,
                    422,
                )

    def test_websocket_stream_sends_and_persists_frames(self):
        with self.client.websocket_connect("/ws/telemetry?load_scale=0") as websocket:
            frames = [websocket.receive_json(), websocket.receive_json()]

        frame, next_frame = frames
        self.assertEqual(frame["sequence"], 1)
        self.assertEqual(next_frame["sequence"], 2)
        self.assertGreater(next_frame["timestamp"], frame["timestamp"])
        self.assertEqual(frame["strain_input"]["ex_micro"], 0.0)
        self.assertEqual(frame["strain_input"]["ey_micro"], 0.0)
        self.assertEqual(frame["strain_input"]["gamma_xy_micro"], 0.0)
        self.assertEqual(frame["source"], "simulated")
        self.assertEqual([sensor["id"] for sensor in frame["spatial_sensors"]], ["R1", "R2", "R3", "R4", "R5"])
        self.assertEqual(self.store.latest()["sequence"], 2)

    @staticmethod
    def valid_beam_request():
        return {
            "length_m": 6.0,
            "youngs_modulus_gpa": 200.0,
            "inertia_cm4": 5000.0,
            "extreme_fibre_mm": 100.0,
            "support_type": "simply-supported",
            "support_a_m": 0.0,
            "support_b_m": 6.0,
            "intervals": 100,
            "loads": [{"type": "point", "P": 20.0, "x": 3.0}],
        }


if __name__ == "__main__":
    unittest.main()
