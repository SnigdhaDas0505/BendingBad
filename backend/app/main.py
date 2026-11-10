from __future__ import annotations

from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .materials import list_material_presets
from .solver import BeamConfig, analyze_beam, validate_request_data
from .telemetry import TelemetryStore, simulated_strain_stream


class PointLoad(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["point"]
    P: float
    x: float


class DistributedLoad(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["udl"]
    w1: float
    w2: float
    x1: float
    x2: float


class MomentLoad(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["moment"]
    M: float
    x: float


Load = Annotated[PointLoad | DistributedLoad | MomentLoad, Field(discriminator="type")]


class BeamAnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    length_m: float = Field(default=6.0, gt=0, le=100)
    youngs_modulus_gpa: float = Field(default=200.0, gt=0, le=2000)
    inertia_cm4: float = Field(default=5000.0, gt=0, le=1e12)
    extreme_fibre_mm: float = Field(default=100.0, gt=0, le=1e6)
    support_type: Literal[
        "simply-supported", "cantilever-left", "cantilever-right",
        "fixed-fixed", "propped-cantilever", "overhang"
    ] = "simply-supported"
    support_a_m: float = Field(default=0.0, ge=0)
    support_b_m: float = Field(default=6.0, ge=0)
    intervals: int = Field(default=1000, ge=100, le=10000)
    loads: list[Load] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_geometry_and_loads(self):
        raw = self.model_dump()
        try:
            validate_request_data(raw)
        except ValueError as exc:
            raise ValueError(str(exc)) from exc
        return self


app = FastAPI(
    title="BeamLab Analysis API",
    version="1.0.0",
    description="Beam response analysis and simulated live strain-gauge digital-twin telemetry.",
)

telemetry_store = TelemetryStore()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4200", "http://127.0.0.1:4200"],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "BeamLab Analysis API"}


@app.get("/api/materials")
def material_presets():
    return list_material_presets()


@app.post("/api/analyze")
def analyze(request: BeamAnalysisRequest):
    try:
        config = BeamConfig(
            length_m=request.length_m,
            youngs_modulus_gpa=request.youngs_modulus_gpa,
            inertia_cm4=request.inertia_cm4,
            extreme_fibre_mm=request.extreme_fibre_mm,
            support_type=request.support_type,
            support_a_m=request.support_a_m,
            support_b_m=request.support_b_m,
            intervals=request.intervals,
        )
        return analyze_beam(config, [load.model_dump() for load in request.loads])
    except (ValueError, ZeroDivisionError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/telemetry/history")
def telemetry_history(limit: Annotated[int, Query(ge=1, le=1000)] = 100):
    return {"frames": telemetry_store.history(limit)}


@app.get("/api/telemetry/latest")
def latest_telemetry():
    return telemetry_store.latest()


@app.websocket("/ws/telemetry")
async def websocket_telemetry(
    websocket: WebSocket,
    youngs_modulus_gpa: Annotated[float, Query(gt=0, le=2000)] = 200.0,
    poisson_ratio: Annotated[float, Query(gt=-1, lt=0.5)] = 0.29,
    yield_strength_mpa: Annotated[float, Query(gt=0, le=10000)] = 250.0,
    warning_factor_of_safety: Annotated[float, Query(gt=1, le=10)] = 1.3,
    load_scale: Annotated[float, Query(ge=0, le=3)] = 1.0,
):
    await websocket.accept()
    try:
        async for frame in simulated_strain_stream(
            youngs_modulus_gpa=youngs_modulus_gpa,
            poisson_ratio=poisson_ratio,
            yield_strength_mpa=yield_strength_mpa,
            warning_factor_of_safety=warning_factor_of_safety,
            load_scale=load_scale,
        ):
            telemetry_store.insert(frame)
            await websocket.send_json(frame)
    except WebSocketDisconnect:
        pass
