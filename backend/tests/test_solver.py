import unittest

from app.solver import BeamConfig, analyze_beam, validate_request_data


class BeamSolverTests(unittest.TestCase):
    def setUp(self):
        self.config = BeamConfig(
            length_m=6.0,
            youngs_modulus_gpa=200.0,
            inertia_cm4=5000.0,
            extreme_fibre_mm=100.0,
            support_type="simply-supported",
            support_a_m=0.0,
            support_b_m=6.0,
            intervals=1000,
        )

    def test_center_point_load_baseline(self):
        result = analyze_beam(self.config, [{"type": "point", "P": 20.0, "x": 3.0}])
        self.assertEqual(result["station_count"], 1001)
        self.assertAlmostEqual(result["reactions"]["RA_kN"], 10.0, places=6)
        self.assertAlmostEqual(result["reactions"]["RB_kN"], 10.0, places=6)
        self.assertAlmostEqual(result["summary"]["max_abs_moment_kNm"], 30.0, places=2)
        self.assertAlmostEqual(result["summary"]["max_abs_deflection_mm"], 9.0, delta=0.03)
        self.assertAlmostEqual(result["summary"]["max_abs_bending_stress_MPa"], 60.0, places=2)
        self.assertAlmostEqual(result["summary"]["max_abs_bending_strain_micro"], 300.0, places=2)

    def test_linearly_varying_distributed_load_resultant(self):
        result = analyze_beam(self.config, [{"type": "udl", "w1": 0.0, "w2": 10.0, "x1": 0.0, "x2": 6.0}])
        self.assertAlmostEqual(result["reactions"]["RA_kN"], 10.0, places=6)
        self.assertAlmostEqual(result["reactions"]["RB_kN"], 20.0, places=6)

    def test_stress_is_returned_at_every_station(self):
        result = analyze_beam(self.config, [{"type": "point", "P": 20.0, "x": 3.0}])
        for point in result["points"]:
            self.assertIn("stress_top_MPa", point)
            self.assertIn("stress_bottom_MPa", point)
            self.assertIn("strain_top_micro", point)
            self.assertIn("strain_bottom_micro", point)
            self.assertAlmostEqual(point["stress_top_MPa"], -point["stress_bottom_MPa"], places=10)

    def test_uniform_udl_equilibrium(self):
        result = analyze_beam(self.config, [{"type": "udl", "w1": 10.0, "w2": 10.0, "x1": 0.0, "x2": 6.0}])
        self.assertAlmostEqual(result["reactions"]["RA_kN"], 30.0, places=6)
        self.assertAlmostEqual(result["reactions"]["RB_kN"], 30.0, places=6)
        self.assertAlmostEqual(result["summary"]["max_abs_moment_kNm"], 45.0, delta=0.05)

    def test_cantilever_right_tip_load_has_fixed_end_kinematics(self):
        config = BeamConfig(4.0, 200.0, 5000.0, 100.0, "cantilever-right", 0.0, 4.0, 1000)
        result = analyze_beam(config, [{"type": "point", "P": 15.0, "x": 0.0}])
        self.assertAlmostEqual(result["points"][-1]["deflection_mm"], 0.0, places=8)
        self.assertAlmostEqual(result["points"][-1]["slope_mrad"], 0.0, places=8)
        self.assertAlmostEqual(result["reactions"]["RB_kN"], 15.0, places=8)
        self.assertAlmostEqual(result["reactions"]["MB_kNm"], 60.0, places=8)

    def test_fixed_fixed_and_propped_end_conditions(self):
        for support in ("fixed-fixed", "propped-cantilever"):
            config = BeamConfig(6.0, 200.0, 5000.0, 100.0, support, 0.0, 6.0, 1000)
            result = analyze_beam(config, [{"type": "udl", "w1": 10.0, "w2": 10.0, "x1": 0.0, "x2": 6.0}])
            self.assertEqual(result["station_count"], 1001)
            self.assertAlmostEqual(result["points"][-1]["deflection_mm"], 0.0, delta=0.0001)

    def test_cantilever_left_tip_load_root_is_fixed(self):
        config = BeamConfig(4.0, 200.0, 5000.0, 100.0, "cantilever-left", 0.0, 4.0, 1000)
        result = analyze_beam(config, [{"type": "point", "P": 15.0, "x": 4.0}])
        self.assertAlmostEqual(result["points"][0]["deflection_mm"], 0.0, places=8)
        self.assertAlmostEqual(result["points"][0]["slope_mrad"], 0.0, places=8)

    def test_zero_load_has_zero_response_at_all_stations(self):
        result = analyze_beam(self.config, [])

        self.assertEqual(result["station_count"], 1001)
        for point in result["points"]:
            for key in (
                "shear_kN", "moment_kNm", "slope_mrad", "deflection_mm",
                "curvature_per_m", "stress_top_MPa", "stress_bottom_MPa",
                "strain_top_micro", "strain_bottom_micro",
            ):
                self.assertAlmostEqual(point[key], 0.0)

    def test_off_centre_point_load_reactions_satisfy_equilibrium(self):
        result = analyze_beam(self.config, [{"type": "point", "P": 12.0, "x": 2.0}])

        self.assertAlmostEqual(result["reactions"]["RA_kN"], 8.0, places=8)
        self.assertAlmostEqual(result["reactions"]["RB_kN"], 4.0, places=8)
        self.assertAlmostEqual(
            result["reactions"]["RB_kN"] * self.config.length_m,
            12.0 * 2.0,
            places=8,
        )
        self.assertAlmostEqual(result["summary"]["max_abs_moment_kNm"], 16.0, delta=0.02)
        self.assertAlmostEqual(result["summary"]["max_moment_at_m"], 2.0, places=2)

    def test_applied_couple_generates_balancing_reactions(self):
        result = analyze_beam(self.config, [{"type": "moment", "M": 10.0, "x": 3.0}])

        self.assertAlmostEqual(result["reactions"]["RA_kN"], -10.0 / 6.0)
        self.assertAlmostEqual(result["reactions"]["RB_kN"], 10.0 / 6.0)
        self.assertAlmostEqual(result["summary"]["max_abs_moment_kNm"], 20.0, places=2)

    def test_point_load_at_support_has_zero_span_moment(self):
        for position, expected_reactions in (
            (0.0, (10.0, 0.0)),
            (6.0, (0.0, 10.0)),
        ):
            with self.subTest(position=position):
                result = analyze_beam(
                    self.config, [{"type": "point", "P": 10.0, "x": position}]
                )
                self.assertAlmostEqual(result["reactions"]["RA_kN"], expected_reactions[0])
                self.assertAlmostEqual(result["reactions"]["RB_kN"], expected_reactions[1])
                self.assertAlmostEqual(result["summary"]["max_abs_moment_kNm"], 0.0)

    def test_upward_point_load_reverses_reactions_and_deflection_sign(self):
        result = analyze_beam(self.config, [{"type": "point", "P": -20.0, "x": 3.0}])

        self.assertAlmostEqual(result["reactions"]["RA_kN"], -10.0)
        self.assertAlmostEqual(result["reactions"]["RB_kN"], -10.0)
        self.assertGreater(result["points"][500]["deflection_mm"], 0.0)
        self.assertGreater(result["points"][500]["stress_top_MPa"], 0.0)
        self.assertLess(result["points"][500]["stress_bottom_MPa"], 0.0)

    def test_load_and_rigidity_scaling_follow_linear_elastic_beam_theory(self):
        baseline = analyze_beam(self.config, [{"type": "point", "P": 20.0, "x": 3.0}])
        doubled_load = analyze_beam(self.config, [{"type": "point", "P": 40.0, "x": 3.0}])
        doubled_rigidity = analyze_beam(
            BeamConfig(6.0, 400.0, 5000.0, 100.0, "simply-supported", 0.0, 6.0, 1000),
            [{"type": "point", "P": 20.0, "x": 3.0}],
        )

        self.assertAlmostEqual(
            doubled_load["summary"]["max_abs_bending_stress_MPa"],
            2 * baseline["summary"]["max_abs_bending_stress_MPa"],
        )
        self.assertAlmostEqual(
            doubled_load["summary"]["max_abs_deflection_mm"],
            2 * baseline["summary"]["max_abs_deflection_mm"],
        )
        self.assertAlmostEqual(
            doubled_rigidity["summary"]["max_abs_deflection_mm"],
            baseline["summary"]["max_abs_deflection_mm"] / 2,
            delta=0.001,
        )
        self.assertAlmostEqual(
            doubled_rigidity["summary"]["max_abs_bending_stress_MPa"],
            baseline["summary"]["max_abs_bending_stress_MPa"],
        )

    def test_all_supported_boundary_conditions_are_satisfied(self):
        cases = (
            ("simply-supported", 0.0, 6.0, [{"type": "udl", "w1": 10.0, "w2": 10.0, "x1": 0.0, "x2": 6.0}]),
            ("cantilever-left", 0.0, 6.0, [{"type": "point", "P": 10.0, "x": 6.0}]),
            ("cantilever-right", 0.0, 6.0, [{"type": "point", "P": 10.0, "x": 0.0}]),
            ("fixed-fixed", 0.0, 6.0, [{"type": "udl", "w1": 10.0, "w2": 10.0, "x1": 0.0, "x2": 6.0}]),
            ("propped-cantilever", 0.0, 6.0, [{"type": "udl", "w1": 10.0, "w2": 10.0, "x1": 0.0, "x2": 6.0}]),
            ("overhang", 1.0, 5.0, [{"type": "point", "P": 10.0, "x": 6.0}]),
        )
        for support, support_a, support_b, loads in cases:
            with self.subTest(support=support):
                config = BeamConfig(
                    6.0, 200.0, 5000.0, 100.0, support, support_a, support_b, 600
                )
                result = analyze_beam(config, loads)
                points = result["points"]
                self.assertAlmostEqual(points[0]["x_m"], 0.0)
                self.assertAlmostEqual(points[-1]["x_m"], config.length_m)
                self.assertAlmostEqual(result["dx_m"], config.length_m / config.intervals)
                if support in ("simply-supported", "overhang"):
                    for x_support in (support_a, support_b):
                        index = round(x_support / result["dx_m"])
                        self.assertAlmostEqual(points[index]["deflection_mm"], 0.0, delta=0.002)
                elif support == "cantilever-left":
                    self.assertAlmostEqual(points[0]["deflection_mm"], 0.0, places=8)
                    self.assertAlmostEqual(points[0]["slope_mrad"], 0.0, places=8)
                elif support == "cantilever-right":
                    self.assertAlmostEqual(points[-1]["deflection_mm"], 0.0, places=8)
                    self.assertAlmostEqual(points[-1]["slope_mrad"], 0.0, places=8)
                elif support == "fixed-fixed":
                    self.assertAlmostEqual(points[0]["deflection_mm"], 0.0, places=8)
                    self.assertAlmostEqual(points[0]["slope_mrad"], 0.0, places=8)
                    self.assertAlmostEqual(points[-1]["deflection_mm"], 0.0, delta=0.002)
                    self.assertAlmostEqual(points[-1]["slope_mrad"], 0.0, delta=0.002)
                else:
                    self.assertAlmostEqual(points[0]["deflection_mm"], 0.0, places=8)
                    self.assertAlmostEqual(points[0]["slope_mrad"], 0.0, places=8)
                    self.assertAlmostEqual(points[-1]["deflection_mm"], 0.0, delta=0.002)

    def test_fixed_fixed_uniform_load_has_symmetric_reactions(self):
        config = BeamConfig(6.0, 200.0, 5000.0, 100.0, "fixed-fixed", 0.0, 6.0, 1000)
        result = analyze_beam(
            config,
            [{"type": "udl", "w1": 10.0, "w2": 10.0, "x1": 0.0, "x2": 6.0}],
        )

        self.assertAlmostEqual(result["reactions"]["RA_kN"], 30.0, delta=0.01)
        self.assertAlmostEqual(result["reactions"]["RB_kN"], 30.0, delta=0.01)
        self.assertAlmostEqual(result["reactions"]["MA_kNm"], 30.0, delta=0.02)
        self.assertAlmostEqual(result["reactions"]["MB_kNm"], -30.0, delta=0.02)

    def test_summary_extrema_match_returned_station_data(self):
        result = analyze_beam(
            self.config, [{"type": "udl", "w1": 2.0, "w2": 12.0, "x1": 0.5, "x2": 5.5}]
        )
        summary = result["summary"]
        keys = (
            ("shear_kN", "max_abs_shear_kN", "max_shear_at_m"),
            ("moment_kNm", "max_abs_moment_kNm", "max_moment_at_m"),
            ("deflection_mm", "max_abs_deflection_mm", "max_deflection_at_m"),
            ("stress_top_MPa", "max_abs_bending_stress_MPa", "max_stress_at_m"),
            ("strain_top_micro", "max_abs_bending_strain_micro", "max_strain_at_m"),
        )
        for value_key, magnitude_key, position_key in keys:
            point = max(result["points"], key=lambda p: abs(p[value_key]))
            with self.subTest(value=value_key):
                self.assertAlmostEqual(summary[magnitude_key], abs(point[value_key]))
                self.assertAlmostEqual(summary[position_key], point["x_m"])

    def test_point_positions_are_validated_including_non_finite_values(self):
        for kind in ("point", "moment"):
            for position in (-0.1, 6.1, float("nan"), float("inf")):
                with self.subTest(kind=kind, position=position):
                    load = (
                        {"type": kind, "P": 1.0, "x": position}
                        if kind == "point"
                        else {"type": kind, "M": 1.0, "x": position}
                    )
                    with self.assertRaisesRegex(ValueError, "positions must lie within"):
                        validate_request_data({**self.valid_request(), "loads": [load]})

    def test_distributed_load_geometry_and_intensities_are_validated(self):
        invalid_loads = (
            {"type": "udl", "w1": 1.0, "w2": 1.0, "x1": 2.0, "x2": 2.0},
            {"type": "udl", "w1": 1.0, "w2": 1.0, "x1": -1.0, "x2": 2.0},
            {"type": "udl", "w1": 1.0, "w2": 1.0, "x1": 0.0, "x2": 7.0},
            {"type": "udl", "w1": float("nan"), "w2": 1.0, "x1": 0.0, "x2": 2.0},
            {"type": "udl", "w1": 1.0, "w2": float("inf"), "x1": 0.0, "x2": 2.0},
        )
        for load in invalid_loads:
            with self.subTest(load=load):
                with self.assertRaises(ValueError):
                    validate_request_data({**self.valid_request(), "loads": [load]})

    def test_point_and_moment_magnitudes_must_be_finite(self):
        invalid_loads = (
            {"type": "point", "P": float("nan"), "x": 1.0},
            {"type": "moment", "M": float("inf"), "x": 1.0},
        )
        for load in invalid_loads:
            with self.subTest(load=load):
                with self.assertRaisesRegex(ValueError, "must be finite"):
                    validate_request_data({**self.valid_request(), "loads": [load]})

    def test_beam_geometry_material_and_interval_validation(self):
        invalid_requests = (
            ({"length_m": 0.0}, "Beam length"),
            ({"length_m": float("nan")}, "Beam length"),
            ({"youngs_modulus_gpa": 0.0}, "youngs_modulus_gpa"),
            ({"inertia_cm4": float("inf")}, "inertia_cm4"),
            ({"extreme_fibre_mm": -1.0}, "extreme_fibre_mm"),
            ({"intervals": 99}, "intervals"),
            ({"intervals": 10001}, "intervals"),
            ({"support_a_m": -1.0}, "support_a_m"),
            ({"support_b_m": 7.0}, "support_b_m"),
            ({"support_a_m": 3.0, "support_b_m": 3.0}, "Support B"),
        )
        for change, message in invalid_requests:
            with self.subTest(change=change):
                with self.assertRaisesRegex(ValueError, message):
                    validate_request_data({**self.valid_request(), **change})

    def test_unknown_load_types_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "Unknown load type"):
            validate_request_data({
                **self.valid_request(),
                "loads": [{"type": "distributed", "x1": 0.0, "x2": 1.0}],
            })

    def test_solver_rejects_unsupported_support_types(self):
        config = BeamConfig(6.0, 200.0, 5000.0, 100.0, "unknown-support", 0.0, 6.0, 100)
        with self.assertRaisesRegex(ValueError, "Unsupported support type"):
            analyze_beam(config, [])

    @staticmethod
    def valid_request():
        return {
            "length_m": 6.0,
            "youngs_modulus_gpa": 200.0,
            "inertia_cm4": 5000.0,
            "extreme_fibre_mm": 100.0,
            "support_type": "simply-supported",
            "support_a_m": 0.0,
            "support_b_m": 6.0,
            "intervals": 1000,
            "loads": [],
        }


if __name__ == "__main__":
    unittest.main()
