"""Euler-Bernoulli beam solver used by BeamLab.

Sign convention:
- Positive point/UDL force is downward.
- Positive support reaction is upward.
- Positive sagging moment follows EI*v'' = M; downward deflection is negative (v is positive upward).
- Positive applied couple follows the convention used in the originating prototype.

Stress is linear-elastic flexural normal stress at the top and bottom extreme fibres:
    sigma_x = -M*y/I, epsilon_x = sigma_x/E
This is not a full 3-D stress analysis and does not estimate transverse shear stress.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from copy import deepcopy
from math import isfinite
from typing import Any


@dataclass(frozen=True)
class BeamConfig:
    length_m: float
    youngs_modulus_gpa: float
    inertia_cm4: float
    extreme_fibre_mm: float
    support_type: str
    support_a_m: float
    support_b_m: float
    intervals: int = 1000


def _integrate_trapezoid(values: list[float], dx: float) -> list[float]:
    out = [0.0] * len(values)
    for i in range(1, len(values)):
        out[i] = out[i - 1] + 0.5 * (values[i - 1] + values[i]) * dx
    return out


def _interp(values: list[float], x: float, dx: float) -> float:
    if not values:
        return 0.0
    position = max(0.0, min(len(values) - 1, x / dx))
    lo = int(position)
    hi = min(lo + 1, len(values) - 1)
    ratio = position - lo
    return values[lo] * (1.0 - ratio) + values[hi] * ratio


def _load_resultant(load: dict[str, Any], beam_length: float) -> tuple[float, float]:
    """Return vertical resultant (downward +) and its moment about x=0."""
    kind = load["type"]
    if kind == "point":
        force = float(load["P"])
        x = float(load["x"])
        return force, force * x
    if kind == "moment":
        return 0.0, float(load["M"])
    if kind == "udl":
        x1 = float(load["x1"])
        x2 = float(load["x2"])
        w1 = float(load["w1"])
        w2 = float(load["w2"])
        length = x2 - x1
        if length <= 0:
            return 0.0, 0.0
        slope = (w2 - w1) / length
        force = w1 * length + 0.5 * slope * length**2
        # Integral of (x1 + u) * (w1 + slope*u), u in [0, length].
        first_moment = (
            x1 * force
            + 0.5 * w1 * length**2
            + (slope * length**3) / 3.0
        )
        return force, first_moment
    raise ValueError(f"Unsupported load type: {kind}")


def _external_moment_at(x: float, loads: list[dict[str, Any]]) -> float:
    """Positive magnitude of applied-load moment about a cut at x."""
    moment = 0.0
    for load in loads:
        kind = load["type"]
        if kind == "point":
            a = float(load["x"])
            if a <= x:
                moment += float(load["P"]) * (x - a)
        elif kind == "moment":
            if float(load["x"]) <= x:
                moment += float(load["M"])
        elif kind == "udl":
            x1 = float(load["x1"])
            x2 = float(load["x2"])
            if x <= x1:
                continue
            length = max(0.0, min(x, x2) - x1)
            if length <= 0.0:
                continue
            total_length = max(1e-12, x2 - x1)
            w1 = float(load["w1"])
            slope = (float(load["w2"]) - w1) / total_length
            arm = x - x1
            moment += (
                w1 * arm * length
                - 0.5 * w1 * length**2
                + 0.5 * slope * arm * length**2
                - (slope * length**3) / 3.0
            )
    return moment


def _external_shear_and_moment(
    x: float, loads: list[dict[str, Any]]
) -> tuple[float, float]:
    """Return downward load resultant and positive moment magnitude at x."""
    shear = 0.0
    moment = 0.0
    for load in loads:
        kind = load["type"]
        if kind == "point":
            a = float(load["x"])
            if a <= x:
                force = float(load["P"])
                shear += force
                moment += force * (x - a)
        elif kind == "moment":
            if float(load["x"]) <= x:
                moment += float(load["M"])
        elif kind == "udl":
            x1 = float(load["x1"])
            x2 = float(load["x2"])
            if x <= x1:
                continue
            length = max(0.0, min(x, x2) - x1)
            if length <= 0.0:
                continue
            total_length = max(1e-12, x2 - x1)
            w1 = float(load["w1"])
            slope = (float(load["w2"]) - w1) / total_length
            force = w1 * length + 0.5 * slope * length**2
            shear += force
            arm = x - x1
            moment += (
                w1 * arm * length
                - 0.5 * w1 * length**2
                + 0.5 * slope * arm * length**2
                - (slope * length**3) / 3.0
            )
    return shear, moment


def analyze_beam(
    config: BeamConfig,
    loads: list[dict[str, Any]],
) -> dict[str, Any]:
    """Return a safe copy of a memoized response for an exact beam/load case."""
    load_key = tuple(
        tuple(sorted((key, value) for key, value in load.items()))
        for load in loads
    )
    return deepcopy(_analyze_beam_cached(config, load_key))


@lru_cache(maxsize=16)
def _analyze_beam_cached(
    config: BeamConfig,
    load_key: tuple[tuple[tuple[str, Any], ...], ...],
) -> dict[str, Any]:
    loads = [dict(load) for load in load_key]
    """Solve reactions, V/M diagrams, slope, deflection, bending stress and strain."""
    L = config.length_m
    n = config.intervals
    dx = L / n
    # Convert the public engineering inputs once, then keep the solver in SI.
    # Presentation values are converted back at the response boundary below.
    E_pa = config.youngs_modulus_gpa * 1e9
    I_m4 = config.inertia_cm4 * 1e-8
    EI = E_pa * I_m4  # N m²
    si_loads: list[dict[str, Any]] = []
    for load in loads:
        converted = dict(load)
        if load["type"] == "point":
            converted["P"] = float(load["P"]) * 1e3
        elif load["type"] == "moment":
            converted["M"] = float(load["M"]) * 1e3
        else:
            converted["w1"] = float(load["w1"]) * 1e3
            converted["w2"] = float(load["w2"]) * 1e3
        si_loads.append(converted)
    x_a = config.support_a_m
    x_b = config.support_b_m
    support = config.support_type

    x = [i * dx for i in range(n + 1)]
    total_force = 0.0
    total_moment_0 = 0.0
    for load in si_loads:
        force, moment_0 = _load_resultant(load, L)
        total_force += force
        total_moment_0 += moment_0

    raw_external_moment = [_external_moment_at(xi, si_loads) for xi in x]
    raw_i_theta = _integrate_trapezoid(raw_external_moment, dx)
    raw_i_v = _integrate_trapezoid(raw_i_theta, dx)
    i_theta_end = raw_i_theta[-1]
    i_v_end = raw_i_v[-1]

    RA = RB = MA = MB = 0.0
    if support in ("simply-supported", "overhang"):
        span = x_b - x_a
        if span <= 1e-9:
            raise ValueError("Support B must be to the right of support A.")
        moment_about_a = total_moment_0 - total_force * x_a
        RB = moment_about_a / span
        RA = total_force - RB
    elif support == "cantilever-left":
        RA = total_force
        MA = total_moment_0
        x_a, x_b = 0.0, L
    elif support == "cantilever-right":
        RB = total_force
        # The support couple balances the moment of the applied loads about x=L.
        MB = total_force * L - total_moment_0
        x_a, x_b = 0.0, L
    elif support == "fixed-fixed":
        x_a, x_b = 0.0, L
        MA = (2.0 * L * i_theta_end - 6.0 * i_v_end) / (L**2)
        RA = (6.0 * L * i_theta_end - 12.0 * i_v_end) / (L**3)
        RB = total_force - RA
        MB = RA * L - MA - raw_external_moment[-1]
    elif support == "propped-cantilever":
        x_a, x_b = 0.0, L
        m_ext_l = raw_external_moment[-1]
        RA = (3.0 * m_ext_l * L**2 - 6.0 * i_v_end) / (2.0 * L**3)
        MA = RA * L - m_ext_l
        RB = total_force - RA
    else:
        raise ValueError(f"Unsupported support type: {support}")

    shear: list[float] = []
    moment: list[float] = []
    for xi in x:
        v_external, m_external = _external_shear_and_moment(xi, si_loads)
        v_internal = 0.0
        m_internal = 0.0
        if xi >= x_a:
            v_internal += RA
            m_internal += RA * (xi - x_a)
        if support in ("cantilever-left", "fixed-fixed", "propped-cantilever"):
            m_internal -= MA
        if xi >= x_b and support in (
            "simply-supported", "overhang", "cantilever-right", "fixed-fixed", "propped-cantilever"
        ):
            v_internal += RB
            m_internal += RB * (xi - x_b)
        v_internal -= v_external
        m_internal -= m_external
        shear.append(v_internal)
        moment.append(m_internal)

    theta_raw = _integrate_trapezoid([m / EI for m in moment], dx)
    v_raw = _integrate_trapezoid(theta_raw, dx)

    C1 = C2 = 0.0
    if support in ("simply-supported", "overhang"):
        v_a_raw = _interp(v_raw, x_a, dx)
        v_b_raw = _interp(v_raw, x_b, dx)
        C1 = (v_a_raw - v_b_raw) / (x_b - x_a)
        C2 = -v_a_raw - C1 * x_a
    elif support == "cantilever-right":
        C1 = -theta_raw[-1]
        C2 = -v_raw[-1] - C1 * L

    theta = [(value + C1) * 1000.0 for value in theta_raw]  # mrad
    deflection = [
        (v_raw[i] + C1 * x[i] + C2) * 1000.0 for i in range(n + 1)
    ]  # mm

    # sigma = M*c/I in Pa; expose MPa in the API response.
    stress_factor = (config.extreme_fibre_mm * 1e-3) / I_m4 / 1e6
    points: list[dict[str, float | int]] = []
    for i, xi in enumerate(x):
        sigma_top = -moment[i] * stress_factor
        sigma_bottom = moment[i] * stress_factor
        epsilon_top = sigma_top / (config.youngs_modulus_gpa * 1000.0)
        epsilon_bottom = sigma_bottom / (config.youngs_modulus_gpa * 1000.0)
        points.append({
            "node": i,
            "x_m": xi,
            "shear_kN": shear[i] / 1e3,
            "moment_kNm": moment[i] / 1e3,
            "slope_mrad": theta[i],
            "deflection_mm": deflection[i],
            "curvature_per_m": moment[i] / EI,
            "stress_top_MPa": sigma_top,
            "stress_bottom_MPa": sigma_bottom,
            "strain_top_micro": epsilon_top * 1e6,
            "strain_bottom_micro": epsilon_bottom * 1e6,
        })

    def extremum(key: str, absolute: bool = True) -> tuple[float, float]:
        item = max(points, key=lambda p: abs(float(p[key])) if absolute else float(p[key]))
        return float(item[key]), float(item["x_m"])

    vmax, vmax_x = extremum("shear_kN")
    mmax, mmax_x = extremum("moment_kNm")
    dmax, dmax_x = extremum("deflection_mm")
    tmax, tmax_x = extremum("slope_mrad")
    sigma_max, sigma_x = extremum("stress_top_MPa")
    strain_max, strain_x = extremum("strain_top_micro")

    if support in ("simply-supported", "overhang"):
        boundary = f"v({x_a:.3f} m) = 0 and v({x_b:.3f} m) = 0"
    elif support == "cantilever-left":
        boundary = "v(0) = 0 and θ(0) = 0"
    elif support == "cantilever-right":
        boundary = f"v({L:.3f} m) = 0 and θ({L:.3f} m) = 0"
    elif support == "fixed-fixed":
        boundary = "v(0) = θ(0) = v(L) = θ(L) = 0"
    else:
        boundary = "v(0) = θ(0) = v(L) = 0"

    return {
        "intervals": n,
        "station_count": len(points),
        "dx_m": dx,
        "EI_kNm2": EI / 1e3,
        "reactions": {"RA_kN": RA / 1e3, "RB_kN": RB / 1e3, "MA_kNm": MA / 1e3, "MB_kNm": MB / 1e3},
        "integration_constants": {"C1_rad": C1, "C2_m": C2},
        "boundary_conditions": boundary,
        "summary": {
            "max_abs_shear_kN": abs(vmax), "max_shear_at_m": vmax_x,
            "max_abs_moment_kNm": abs(mmax), "max_moment_at_m": mmax_x,
            "max_abs_deflection_mm": abs(dmax), "max_deflection_at_m": dmax_x,
            "max_abs_slope_mrad": abs(tmax), "max_slope_at_m": tmax_x,
            "max_abs_bending_stress_MPa": abs(sigma_max), "max_stress_at_m": sigma_x,
            "max_abs_bending_strain_micro": abs(strain_max), "max_strain_at_m": strain_x,
        },
        "points": points,
    }


def validate_request_data(data: dict[str, Any]) -> None:
    """Small validation helper also used by unit tests."""
    L = float(data["length_m"])
    if not isfinite(L) or L <= 0:
        raise ValueError("Beam length must be greater than zero.")
    for key in ("youngs_modulus_gpa", "inertia_cm4", "extreme_fibre_mm"):
        value = float(data[key])
        if not isfinite(value) or value <= 0:
            raise ValueError(f"{key} must be greater than zero.")
    intervals = int(data.get("intervals", 1000))
    if intervals < 100 or intervals > 10000:
        raise ValueError("intervals must be between 100 and 10,000.")
    for key in ("support_a_m", "support_b_m"):
        value = float(data[key])
        if not isfinite(value) or value < 0 or value > L:
            raise ValueError(f"{key} must lie within the beam span.")
    if data["support_type"] in ("simply-supported", "overhang"):
        if float(data["support_b_m"]) <= float(data["support_a_m"]):
            raise ValueError("Support B must be to the right of support A.")
    for load in data.get("loads", []):
        kind = load["type"]
        if kind == "point" or kind == "moment":
            a = float(load["x"])
            if not isfinite(a) or not (0 <= a <= L):
                raise ValueError("Point load and moment positions must lie within the beam span.")
            magnitude_key = "P" if kind == "point" else "M"
            if not isfinite(float(load[magnitude_key])):
                raise ValueError(f"{magnitude_key} must be finite.")
        elif kind == "udl":
            x1, x2 = float(load["x1"]), float(load["x2"])
            if not (isfinite(x1) and isfinite(x2) and 0 <= x1 < x2 <= L):
                raise ValueError("A distributed load must satisfy 0 ≤ x1 < x2 ≤ L.")
            if not (isfinite(float(load["w1"])) and isfinite(float(load["w2"]))):
                raise ValueError("Distributed-load intensities must be finite.")
        else:
            raise ValueError("Unknown load type.")
