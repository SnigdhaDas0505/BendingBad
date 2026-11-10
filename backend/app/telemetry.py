"""Simulated strain-gauge telemetry and plane-stress safety metrics."""

from __future__ import annotations

import asyncio
import json
import math
import random
import sqlite3
import threading
import time
from contextlib import closing
from pathlib import Path
from typing import Any, AsyncIterator


DEFAULT_DATABASE_PATH = Path(__file__).resolve().parents[1] / "data" / "telemetry.sqlite3"
MAX_STORED_FRAMES = 10_000
DATABASE_PRUNE_INTERVAL = 500
SPATIAL_SENSOR_POSITIONS = (0.0, 0.25, 0.5, 0.75, 1.0)


def calculate_stress_metrics(
    ex_micro: float,
    ey_micro: float,
    gamma_xy_micro: float,
    youngs_modulus_gpa: float = 200.0,
    poisson_ratio: float = 0.29,
    yield_strength_mpa: float = 250.0,
    warning_factor_of_safety: float = 1.3,
    *,
    source: str = "simulated",
    sequence: int = 0,
) -> dict[str, Any]:
    """Convert plane-rosette strain (microstrain) into stress and yield-screening metrics."""
    values = (ex_micro, ey_micro, gamma_xy_micro, youngs_modulus_gpa,
              poisson_ratio, yield_strength_mpa, warning_factor_of_safety)
    if not all(math.isfinite(value) for value in values):
        raise ValueError("Strain and material values must be finite.")
    if youngs_modulus_gpa <= 0:
        raise ValueError("Young's modulus must be positive.")
    if not -1.0 < poisson_ratio < 0.5:
        raise ValueError("Poisson's ratio must be between -1 and 0.5.")
    if yield_strength_mpa <= 0:
        raise ValueError("Yield strength must be positive.")
    if warning_factor_of_safety <= 1:
        raise ValueError("The warning factor of safety must be greater than 1.")

    ex = ex_micro * 1e-6
    ey = ey_micro * 1e-6
    gamma_xy = gamma_xy_micro * 1e-6
    modulus_mpa = youngs_modulus_gpa * 1000.0
    plane_stress_factor = modulus_mpa / (1.0 - poisson_ratio**2)
    sigma_x = plane_stress_factor * (ex + poisson_ratio * ey)
    sigma_y = plane_stress_factor * (ey + poisson_ratio * ex)
    tau_xy = modulus_mpa / (2.0 * (1.0 + poisson_ratio)) * gamma_xy

    center = (sigma_x + sigma_y) / 2.0
    radius = math.hypot((sigma_x - sigma_y) / 2.0, tau_xy)
    sigma_1 = center + radius
    sigma_2 = center - radius
    von_mises = math.sqrt(max(
        0.0,
        sigma_x**2 - sigma_x * sigma_y + sigma_y**2 + 3.0 * tau_xy**2,
    ))
    factor_of_safety = yield_strength_mpa / von_mises if von_mises > 1e-12 else None
    principal_angle = 0.5 * math.degrees(math.atan2(2.0 * tau_xy, sigma_x - sigma_y))

    if factor_of_safety is None:
        alert_level = "NORMAL"
        alert_message = "No equivalent stress detected; the yield-based factor of safety is unbounded."
    elif factor_of_safety < 1.0:
        alert_level = "CRITICAL"
        alert_message = (
            f"Yield strength exceeded: von Mises stress is {von_mises:.2f} MPa "
            f"against {yield_strength_mpa:.2f} MPa."
        )
    elif factor_of_safety < warning_factor_of_safety:
        alert_level = "WARNING"
        alert_message = f"Factor of safety is below the warning threshold ({factor_of_safety:.2f})."
    else:
        alert_level = "NORMAL"
        alert_message = "Operating within the configured yield-screening margin."

    return {
        "sequence": sequence,
        "timestamp": time.time() * 1000.0,
        "source": source,
        "strain_input": {
            "ex_micro": ex_micro,
            "ey_micro": ey_micro,
            "gamma_xy_micro": gamma_xy_micro,
        },
        "stress_tensor": {
            "sigma_x_mpa": sigma_x,
            "sigma_y_mpa": sigma_y,
            "tau_xy_mpa": tau_xy,
        },
        "mohrs_circle": {
            "center_mpa": center,
            "radius_mpa": radius,
            "sigma_1_mpa": sigma_1,
            "sigma_2_mpa": sigma_2,
            "tau_max_mpa": radius,
            "principal_angle_deg": principal_angle,
        },
        "material": {
            "youngs_modulus_gpa": youngs_modulus_gpa,
            "poisson_ratio": poisson_ratio,
            "yield_strength_mpa": yield_strength_mpa,
            "von_mises_mpa": von_mises,
            "factor_of_safety": factor_of_safety,
            "warning_factor_of_safety": warning_factor_of_safety,
        },
        "alert": {"level": alert_level, "message": alert_message},
    }


def spatial_strain_profile(
    ex_micro: float,
    ey_micro: float,
    gamma_xy_micro: float,
) -> list[dict[str, Any]]:
    """Create a five-point illustrative simply-supported strain envelope from one demo sample."""
    nodes = []
    for index, x_ratio in enumerate(SPATIAL_SENSOR_POSITIONS, start=1):
        bending_factor = math.sin(math.pi * x_ratio)
        shear_factor = math.cos(math.pi * x_ratio)
        nodes.append({
            "id": f"R{index}",
            "label": f"Rosette {index} · {x_ratio:.0%} span",
            "x_ratio": x_ratio,
            "strain_input": {
                "ex_micro": ex_micro * bending_factor,
                "ey_micro": ey_micro * bending_factor,
                "gamma_xy_micro": gamma_xy_micro * shear_factor,
            },
        })
    return nodes


async def simulated_strain_stream(
    *,
    youngs_modulus_gpa: float = 200.0,
    poisson_ratio: float = 0.29,
    yield_strength_mpa: float = 250.0,
    warning_factor_of_safety: float = 1.3,
    load_scale: float = 1.0,
    interval_seconds: float = 0.1,
) -> AsyncIterator[dict[str, Any]]:
    """Yield a 10 Hz demonstration stream with cyclic loads, noise, and occasional shocks."""
    if not math.isfinite(load_scale) or not 0.0 <= load_scale <= 3.0:
        raise ValueError("Simulated load level must be between 0 and 3.")
    start = time.monotonic()
    sequence = 0
    while True:
        elapsed = time.monotonic() - start
        reference_ex = load_scale * (500.0 + 400.0 * math.sin(elapsed * 0.8))
        reference_ey = load_scale * (-150.0 - 120.0 * math.sin(elapsed * 0.8))
        reference_gamma_xy = load_scale * 180.0 * math.cos(elapsed * 0.5)
        noise_ex = load_scale * random.uniform(-15.0, 15.0)
        noise_ey = load_scale * random.uniform(-10.0, 10.0)
        noise_gamma_xy = load_scale * random.uniform(-8.0, 8.0)
        if random.random() < 0.045:
            reference_ex += load_scale * random.uniform(700.0, 1100.0)
            reference_gamma_xy += load_scale * random.uniform(200.0, 400.0)
        ex_micro = reference_ex + noise_ex
        ey_micro = reference_ey + noise_ey
        gamma_xy_micro = reference_gamma_xy + noise_gamma_xy
        sequence += 1
        frame = calculate_stress_metrics(
            ex_micro,
            ey_micro,
            gamma_xy_micro,
            youngs_modulus_gpa,
            poisson_ratio,
            yield_strength_mpa,
            warning_factor_of_safety,
            sequence=sequence,
        )
        frame["spatial_sensors"] = spatial_strain_profile(ex_micro, ey_micro, gamma_xy_micro)
        yield frame
        await asyncio.sleep(interval_seconds)


class TelemetryStore:
    """Small SQLite history store for local simulation and dashboard inspection."""

    def __init__(self, database_path: Path = DEFAULT_DATABASE_PATH) -> None:
        self.database_path = database_path
        self._write_count = 0
        self._initialized = False
        self._initialization_lock = threading.Lock()

    def _ensure_schema(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        if self._initialized:
            return
        with self._initialization_lock:
            if self._initialized:
                return
            with closing(sqlite3.connect(self.database_path, timeout=5.0)) as connection:
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS telemetry_frames (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        timestamp REAL NOT NULL,
                        source TEXT NOT NULL,
                        alert_level TEXT NOT NULL,
                        factor_of_safety REAL,
                        von_mises_mpa REAL NOT NULL,
                        payload_json TEXT NOT NULL
                    )
                    """
                )
                connection.execute(
                    "CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry_frames(timestamp)"
                )
                connection.commit()
            self._initialized = True

    def _connect(self) -> sqlite3.Connection:
        self._ensure_schema()
        connection = sqlite3.connect(self.database_path, timeout=5.0)
        connection.row_factory = sqlite3.Row
        return connection

    def insert(self, frame: dict[str, Any]) -> None:
        with closing(self._connect()) as connection:
            with connection:
                connection.execute(
                    """
                    INSERT INTO telemetry_frames
                        (timestamp, source, alert_level, factor_of_safety, von_mises_mpa, payload_json)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        frame["timestamp"],
                        frame["source"],
                        frame["alert"]["level"],
                        frame["material"]["factor_of_safety"],
                        frame["material"]["von_mises_mpa"],
                        json.dumps(frame, separators=(",", ":"), allow_nan=False),
                    ),
                )
                self._write_count += 1
                if self._write_count % DATABASE_PRUNE_INTERVAL == 0:
                    connection.execute(
                        """
                        DELETE FROM telemetry_frames
                        WHERE id NOT IN (
                            SELECT id FROM telemetry_frames ORDER BY id DESC LIMIT ?
                        )
                        """,
                        (MAX_STORED_FRAMES,),
                    )

    def history(self, limit: int = 100) -> list[dict[str, Any]]:
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT payload_json FROM telemetry_frames ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [json.loads(row["payload_json"]) for row in reversed(rows)]

    def latest(self) -> dict[str, Any] | None:
        frames = self.history(limit=1)
        return frames[-1] if frames else None
