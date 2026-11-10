import asyncio
import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.telemetry import (
    TelemetryStore,
    calculate_stress_metrics,
    simulated_strain_stream,
    spatial_strain_profile,
)


class StressTelemetryTests(unittest.TestCase):
    def test_uniaxial_rosette_converts_strain_to_stress_and_factor_of_safety(self):
        frame = calculate_stress_metrics(1000.0, -290.0, 0.0)

        self.assertAlmostEqual(frame["stress_tensor"]["sigma_x_mpa"], 200.0)
        self.assertAlmostEqual(frame["stress_tensor"]["sigma_y_mpa"], 0.0)
        self.assertAlmostEqual(frame["mohrs_circle"]["sigma_1_mpa"], 200.0)
        self.assertAlmostEqual(frame["mohrs_circle"]["sigma_2_mpa"], 0.0)
        self.assertAlmostEqual(frame["material"]["von_mises_mpa"], 200.0)
        self.assertAlmostEqual(frame["material"]["factor_of_safety"], 1.25)
        self.assertEqual(frame["alert"]["level"], "WARNING")

    def test_shear_only_state_calculates_in_plane_shear_and_von_mises(self):
        frame = calculate_stress_metrics(0.0, 0.0, 1000.0)
        expected_shear = 200000.0 / (2 * 1.29) * 0.001

        self.assertAlmostEqual(frame["stress_tensor"]["tau_xy_mpa"], expected_shear)
        self.assertAlmostEqual(frame["mohrs_circle"]["tau_max_mpa"], expected_shear)
        self.assertAlmostEqual(frame["material"]["von_mises_mpa"], math.sqrt(3) * expected_shear)
        self.assertAlmostEqual(frame["mohrs_circle"]["sigma_1_mpa"], expected_shear)
        self.assertAlmostEqual(frame["mohrs_circle"]["sigma_2_mpa"], -expected_shear)

    def test_equal_biaxial_strain_has_equal_principal_stress_and_zero_shear(self):
        frame = calculate_stress_metrics(1000.0, 1000.0, 0.0)

        sigma = frame["stress_tensor"]["sigma_x_mpa"]
        self.assertAlmostEqual(sigma, frame["stress_tensor"]["sigma_y_mpa"])
        self.assertAlmostEqual(frame["stress_tensor"]["tau_xy_mpa"], 0.0)
        self.assertAlmostEqual(frame["mohrs_circle"]["sigma_1_mpa"], sigma)
        self.assertAlmostEqual(frame["mohrs_circle"]["sigma_2_mpa"], sigma)
        self.assertAlmostEqual(frame["mohrs_circle"]["radius_mpa"], 0.0)
        self.assertAlmostEqual(frame["material"]["von_mises_mpa"], abs(sigma))

    def test_principal_stress_invariants_match_stress_tensor(self):
        frame = calculate_stress_metrics(850.0, -240.0, 375.0)
        tensor = frame["stress_tensor"]
        circle = frame["mohrs_circle"]

        self.assertAlmostEqual(circle["sigma_1_mpa"] + circle["sigma_2_mpa"], tensor["sigma_x_mpa"] + tensor["sigma_y_mpa"])
        self.assertAlmostEqual(
            circle["sigma_1_mpa"] * circle["sigma_2_mpa"],
            tensor["sigma_x_mpa"] * tensor["sigma_y_mpa"] - tensor["tau_xy_mpa"] ** 2,
        )
        expected_von_mises = math.sqrt(
            tensor["sigma_x_mpa"] ** 2
            - tensor["sigma_x_mpa"] * tensor["sigma_y_mpa"]
            + tensor["sigma_y_mpa"] ** 2
            + 3.0 * tensor["tau_xy_mpa"] ** 2
        )
        self.assertAlmostEqual(frame["material"]["von_mises_mpa"], expected_von_mises)
        self.assertAlmostEqual(circle["tau_max_mpa"], circle["radius_mpa"])
        self.assertGreaterEqual(circle["sigma_1_mpa"], circle["sigma_2_mpa"])

    def test_yield_exceedance_is_critical(self):
        frame = calculate_stress_metrics(1500.0, -435.0, 0.0)

        self.assertLess(frame["material"]["factor_of_safety"], 1.0)
        self.assertEqual(frame["alert"]["level"], "CRITICAL")

    def test_alert_threshold_boundaries(self):
        base = calculate_stress_metrics(1000.0, -290.0, 0.0)
        stress = base["material"]["von_mises_mpa"]
        at_yield = calculate_stress_metrics(1000.0, -290.0, 0.0, yield_strength_mpa=stress)
        at_warning = calculate_stress_metrics(
            1000.0,
            -290.0,
            0.0,
            yield_strength_mpa=stress * 1.3,
            warning_factor_of_safety=1.3,
        )

        self.assertAlmostEqual(at_yield["material"]["factor_of_safety"], 1.0)
        self.assertEqual(at_yield["alert"]["level"], "WARNING")
        self.assertAlmostEqual(at_warning["material"]["factor_of_safety"], 1.3)
        self.assertEqual(at_warning["alert"]["level"], "NORMAL")

    def test_zero_stress_has_unbounded_safety_factor(self):
        frame = calculate_stress_metrics(0.0, 0.0, 0.0)

        self.assertIsNone(frame["material"]["factor_of_safety"])
        self.assertEqual(frame["alert"]["level"], "NORMAL")

    def test_invalid_material_properties_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "Poisson"):
            calculate_stress_metrics(0.0, 0.0, 0.0, poisson_ratio=0.5)
        with self.assertRaisesRegex(ValueError, "finite"):
            calculate_stress_metrics(float("nan"), 0.0, 0.0)

    def test_each_material_parameter_requires_a_valid_range(self):
        invalid_inputs = (
            ({"youngs_modulus_gpa": 0.0}, "Young"),
            ({"poisson_ratio": -1.0}, "Poisson"),
            ({"poisson_ratio": 0.5}, "Poisson"),
            ({"yield_strength_mpa": 0.0}, "Yield"),
            ({"warning_factor_of_safety": 1.0}, "warning"),
            ({"warning_factor_of_safety": float("inf")}, "finite"),
        )
        for kwargs, message in invalid_inputs:
            with self.subTest(kwargs=kwargs):
                with self.assertRaisesRegex(ValueError, message):
                    calculate_stress_metrics(0.0, 0.0, 0.0, **kwargs)

    def test_each_strain_component_must_be_finite(self):
        for strains in (
            (float("nan"), 0.0, 0.0),
            (0.0, float("inf"), 0.0),
            (0.0, 0.0, float("-inf")),
        ):
            with self.subTest(strains=strains):
                with self.assertRaisesRegex(ValueError, "finite"):
                    calculate_stress_metrics(*strains)

    def test_zero_simulated_load_produces_zero_strain(self):
        async def first_frame():
            stream = simulated_strain_stream(load_scale=0.0, interval_seconds=0.0)
            try:
                return await anext(stream)
            finally:
                await stream.aclose()

        frame = asyncio.run(first_frame())
        self.assertEqual(frame["strain_input"]["ex_micro"], 0.0)
        self.assertEqual(frame["strain_input"]["ey_micro"], 0.0)
        self.assertEqual(frame["strain_input"]["gamma_xy_micro"], 0.0)
        self.assertIsNone(frame["material"]["factor_of_safety"])
        self.assertEqual(len(frame["spatial_sensors"]), 5)
        self.assertEqual(frame["spatial_sensors"][2]["strain_input"]["ex_micro"], 0.0)

    def test_spatial_profile_peaks_in_bending_at_midspan_and_shear_at_supports(self):
        sensors = spatial_strain_profile(1000.0, -290.0, 450.0)

        self.assertEqual([sensor["id"] for sensor in sensors], ["R1", "R2", "R3", "R4", "R5"])
        self.assertEqual([sensor["x_ratio"] for sensor in sensors], [0.0, 0.25, 0.5, 0.75, 1.0])
        self.assertAlmostEqual(sensors[0]["strain_input"]["ex_micro"], 0.0)
        self.assertAlmostEqual(sensors[2]["strain_input"]["ex_micro"], 1000.0)
        self.assertAlmostEqual(sensors[4]["strain_input"]["ex_micro"], 0.0)
        self.assertAlmostEqual(sensors[0]["strain_input"]["gamma_xy_micro"], 450.0)
        self.assertAlmostEqual(sensors[2]["strain_input"]["gamma_xy_micro"], 0.0, places=12)
        self.assertAlmostEqual(sensors[4]["strain_input"]["gamma_xy_micro"], -450.0)

    def test_simulated_stream_increments_sequences_and_passes_material_settings(self):
        async def first_two_frames():
            stream = simulated_strain_stream(
                youngs_modulus_gpa=70.0,
                poisson_ratio=0.25,
                yield_strength_mpa=180.0,
                warning_factor_of_safety=1.5,
                load_scale=0.0,
                interval_seconds=0.0,
            )
            try:
                return await anext(stream), await anext(stream)
            finally:
                await stream.aclose()

        first, second = asyncio.run(first_two_frames())
        self.assertEqual((first["sequence"], second["sequence"]), (1, 2))
        self.assertEqual(first["material"]["youngs_modulus_gpa"], 70.0)
        self.assertEqual(first["material"]["poisson_ratio"], 0.25)
        self.assertEqual(first["material"]["yield_strength_mpa"], 180.0)
        self.assertEqual(first["material"]["warning_factor_of_safety"], 1.5)

    def test_simulated_load_scale_is_bounded(self):
        async def first_frame():
            stream = simulated_strain_stream(load_scale=3.1)
            return await anext(stream)

        with self.assertRaisesRegex(ValueError, "between 0 and 3"):
            asyncio.run(first_frame())


class TelemetryStoreTests(unittest.TestCase):
    def test_empty_store_has_no_latest_frame(self):
        with tempfile.TemporaryDirectory() as directory:
            store = TelemetryStore(Path(directory) / "telemetry.sqlite3")
            self.assertIsNone(store.latest())
            self.assertEqual(store.history(), [])

    def test_history_returns_newest_frames_in_time_order(self):
        with tempfile.TemporaryDirectory() as directory:
            store = TelemetryStore(Path(directory) / "telemetry.sqlite3")
            first = calculate_stress_metrics(100.0, 0.0, 0.0, sequence=1)
            second = calculate_stress_metrics(200.0, 0.0, 0.0, sequence=2)
            third = calculate_stress_metrics(300.0, 0.0, 0.0, sequence=3)
            for frame in (first, second, third):
                store.insert(frame)

            self.assertEqual(
                [frame["sequence"] for frame in store.history(limit=2)],
                [2, 3],
            )
            self.assertEqual(store.latest()["sequence"], 3)

    def test_history_persists_across_store_instances(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "telemetry.sqlite3"
            frame = calculate_stress_metrics(100.0, 0.0, 0.0, sequence=7)
            TelemetryStore(database).insert(frame)

            self.assertEqual(TelemetryStore(database).latest()["sequence"], 7)

    def test_database_pruning_retains_only_the_newest_configured_frames(self):
        with tempfile.TemporaryDirectory() as directory:
            store = TelemetryStore(Path(directory) / "telemetry.sqlite3")
            with patch("app.telemetry.DATABASE_PRUNE_INTERVAL", 3), patch(
                "app.telemetry.MAX_STORED_FRAMES", 2
            ):
                for sequence in range(1, 7):
                    store.insert(calculate_stress_metrics(100.0, 0.0, 0.0, sequence=sequence))

            self.assertEqual([frame["sequence"] for frame in store.history(limit=10)], [5, 6])

    def test_invalid_frame_is_rejected_without_writing_data(self):
        with tempfile.TemporaryDirectory() as directory:
            store = TelemetryStore(Path(directory) / "telemetry.sqlite3")
            frame = calculate_stress_metrics(100.0, 0.0, 0.0)
            frame["strain_input"]["ex_micro"] = float("nan")

            with self.assertRaises(ValueError):
                store.insert(frame)
            self.assertEqual(store.history(), [])


if __name__ == "__main__":
    unittest.main()
