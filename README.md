# BeamLab — Angular + Python beam response explorer

BeamLab is a rebuild of the uploaded BeamFlex prototype. It keeps the practical beam-analysis workflow—beam and material properties, support conditions, point/distributed/couple loads, presets, numerical diagrams and CSV export—and makes the beam visualizer the main workspace.

## Stack

- **Frontend:** Angular 21 standalone application, TypeScript and plain CSS.
- **Backend:** Python 3.11+ with FastAPI and Pydantic.
- **Solver:** NumPy-free numerical integration in Python; the default analysis uses 1,000 intervals and returns 1,001 stations.

Angular 21 is pinned as the supported LTS line and works with Node.js 22.12+. See the official [Angular release](https://angular.dev/reference/releases) and [version compatibility](https://angular.dev/reference/versions) tables.

## Run locally

In simple terms: the Python API does the beam calculations, and the Angular app shows them in your browser. Start both services, then open the browser page.

You need Python 3.11+ and Node.js 22.12+ installed. Open two terminals from the project root (`beam-lab-angular-python`).

### 1. Start the Python API

```bash
cd backend
python -m venv .venv

# macOS / Linux
source .venv/bin/activate

# Windows PowerShell
# .venv\Scripts\Activate.ps1

pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

The API health check is available at `http://127.0.0.1:8000/api/health`. Interactive API documentation is at `http://127.0.0.1:8000/docs`.

### 2. Start the Angular app

```bash
cd frontend
npm install
npm start
```

Open `http://localhost:4200`. Angular's development proxy forwards `/api/*` to the Python service on port 8000.

If the page says that the analysis service is unavailable, make sure the API terminal is still running. Leave both terminals open while using the app. Press `Ctrl+C` in either terminal to stop that service.

For a production frontend build:

```bash
cd frontend
npm run build
```

## Tests

Run the backend unit and API tests from the backend directory. Install the optional test dependencies first if needed:

```bash
cd backend
pip install -r requirements-test.txt
python -m unittest discover -s tests -v
```

Run the frontend's yield-screen and Mohr-circle logic tests with Node.js:

```bash
cd frontend
npm test
```

The backend suite exercises beam loads, support boundary conditions, stress/strain, equilibrium, input validation, telemetry transforms and alerts, spatial strain profiles, persistence/pruning, and HTTP/WebSocket endpoints. Frontend tests cover first-yield selection, limit classification, load-factor/utilization math, solver-point interpolation/profile sampling, telemetry URL/reconnect configuration, spatial profiles, and Mohr-circle invariants and plane transformations.

## Main interactions

- Hover across the beam drawing to inspect position, shear, bending moment, slope and deflection.
- The section inspector reports top- and bottom-fibre bending stress and longitudinal strain at the hovered position. Values are linearly interpolated between adjacent numerical stations.
- The beam first-yield screen compares peak flexural stress with the editable yield limit, reports the critical span position and tension/compression face, and estimates the proportional load factor to first yield. Its play control is an illustrative bending/yield-initiation animation, not a fracture simulation. The example yield limit is not inferred from the elastic-modulus preset; enter a certified material value.
- The response diagrams share the beam's horizontal coordinate system. The top-fibre stress diagram is plotted alongside shear, moment and deflection.
- For a simply supported beam with one centered point load, Beam Analysis shows a closed-form hand-check beside the numerical results for peak moment, flexural stress and deflection. It disappears for other cases; it validates this matching idealized case only, not a physical structure.
- Choose a preset or change the material, second moment of area, extreme-fibre distance, support arrangement and loading. The section helper derives I and c for solid rectangles, solid circles and hollow circular sections. The Python API recalculates the full span after an input change.
- The **All stations** table contains every returned station. CSV export includes position, shear, moment, slope, deflection, curvature, both extreme-fibre stresses and both strains.
- Beam Analysis includes a five-position stress heatmap built from the beam solver's results. Select a position to inspect it in the beam section inspector; the same beam, supports and loads remain in view.
- **Live monitor** streams strain values, calculates stress and strength screening, loads recent history, logs threshold crossings, and offers CSV export.
- Beam Analysis uses built-in stiffness presets and an editable yield limit. Live monitor's material selector uses the local `GET /api/materials` catalog and recalculates the same incoming strain samples without restarting the WebSocket. Catalog values are representative only, depend on product specification and condition, and are not design allowables. Timber strength is an illustrative bending-reference proxy, not a yield stress.

## Live monitor prototype

The monitor runs without physical sensors or third-party services. The FastAPI backend generates a 10 Hz demonstration stream with cyclic strain, small noise and occasional transient spikes. It is explicitly marked as simulated in the interface.

The three strain channels represent an idealized 0°/45°/90° rosette. If the measured channels are `ε0`, `ε45`, and `ε90`, the backend inputs are:

- `ex_micro = ε0`
- `ey_micro = ε90`
- `gamma_xy_micro = 2 ε45 − ε0 − ε90` (engineering shear strain)

The API also includes five virtual spatial readings (`spatial_sensors`) at 0%, 25%, 50%, 75%, and 100% of span. This is a deliberately simplified simply-supported envelope derived from the demo sample, not a finite-element result or measured sensor data. The Live monitor displays the current rosette sample; the solver-derived heatmap is available only in Beam Analysis.

The Beam Analysis heatmap interpolates the completed solver response at five evenly spaced positions, with a continuous color strip sampled along the span. Stress and strain come from the solver's extreme-fibre bending results; the heatmap does not add transverse shear stress. Its positions are virtual calculation samples, not sensors.

The backend converts microstrain to strain and applies isotropic plane-stress Hooke's law using the configured Young's modulus and Poisson ratio. It derives principal stresses and the Mohr circle, calculates 2D von Mises stress directly from the stress-tensor components, and sets FoS to `yield_strength / von_mises`. A value below 1 is marked critical; a value below the configurable warning threshold is marked warning. Zero equivalent stress is represented by a `null` (unbounded) FoS.

Frames are persisted to the local SQLite database at `backend/data/telemetry.sqlite3` (created automatically and ignored by Git; the most recent 10,000 frames are retained). The monitor also exposes the history through:

- `GET /api/telemetry/latest`
- `GET /api/telemetry/history?limit=100` (limit 1–1,000)
- `GET /api/materials` (bundled material presets with public source references and strength-basis notes)
- `ws://127.0.0.1:8000/ws/telemetry?youngs_modulus_gpa=200&poisson_ratio=0.29&yield_strength_mpa=250&warning_factor_of_safety=1.3`

The WebSocket query parameters are optional and have the same defaults as the UI; `load_scale` ranges from 0 to 3 and scales the generated rosette strains (0 produces a zero-load frame). The Angular Live monitor loads saved history, reconnects the WebSocket with backoff, plots the rosette's recent FoS, displays its Mohr circle and exports the visible sample window to CSV. Material preset changes do not reconnect the stream; changing the simulated load slider applies that load level when released.

There is no universal public strain-gauge API: gauges need an acquisition device/bridge (often a strain-gauge signal conditioner plus DAQ or microcontroller) that exposes calibrated strain channels. To connect hardware later, have its gateway publish calibrated rosette readings to a backend ingestion adapter, then reuse `calculate_stress_metrics` and the existing SQLite/history pipeline. The current generator is a local development source, not a sensor simulator validated against a particular device.

**Safety scope:** This is an educational prototype, not a safety-rated monitor. FoS here is a static 2D strength screen; the beam first-yield screen uses linear-elastic flexural stress and a user-entered, symmetric yield limit. The bundled properties are representative and should be checked against the exact material/product specification. Timber is anisotropic and its displayed strength is only a bending-reference proxy, not a yield limit. Neither feature predicts fracture or collapse, and neither calculates fatigue life, buckling, damage, sensor faults, temperature compensation, or structural reliability. Do not use the application to protect real equipment.

## Mechanical model and units

The implementation follows the beam-bending and beam-theory topics in the course source, particularly the chapters on bending of beams and Euler–Bernoulli beam theory: [Solid Mechanics for Undergraduates — Ajeet Kumar, IIT Delhi](https://web.iitd.ac.in/~ajeetk/smb/book.html).

The solver uses the Euler–Bernoulli relation

\[
EI\,\frac{d^2v}{dx^2}=M(x)
\]

and integrates the moment/rigidity field twice using the trapezoidal rule. It supports simply supported beams (including custom support locations/overhang), left and right cantilevers, fixed–fixed beams and propped cantilevers. Loads include point forces, linearly varying distributed loads (uniform loading is the equal-intensity case), and applied couples.

Flexural normal stress is evaluated at both extreme fibres at **every station**:

\[
\sigma_x=-\frac{My}{I},\qquad \epsilon_x=\frac{\sigma_x}{E}
\]

With the API units, the top-fibre stress is

\[
\sigma_{top}\,[MPa]=-\,M\,[kN\,m]\,\frac{100\,c\,[mm]}{I\,[cm^4]}
\]

and bottom-fibre stress has the opposite sign for a symmetric section about its neutral axis. Strain is reported in microstrain (\(\mu\epsilon\)). The supplied `extreme_fibre_mm` value is the neutral-axis-to-outer-fibre distance `c`; the supplied `inertia_cm4` is the second moment of area about the bending axis.

### Sign convention

- Positive applied force and positive distributed-load intensity act downward.
- Positive support reaction acts upward.
- Positive sagging moment gives compression at the top fibre and tension at the bottom fibre.
- Deflection `v` is positive upward, so a conventional downward sagging deflection is negative.

### Scope and assumptions

This is an educational, linear-elastic, slender-beam Euler–Bernoulli model with small slopes and constant `E` and `I` along the span. It reports **longitudinal flexural normal stress and strain at the top and bottom extreme fibres**. It does not calculate a full 3-D stress/strain tensor, transverse shear stress, local stress concentrations, plasticity, buckling, or time-dependent effects. Timoshenko shear-deformation effects are not included; those may matter for short/deep beams.

The course book separately discusses stress tensors, strain tensors, stress–strain laws, beam bending and both Euler–Bernoulli and Timoshenko theories. BeamLab implements only the focused beam-response model described above; it is not a complete implementation of the book.

## API contract

`POST /api/analyze` accepts:

- `length_m`, `youngs_modulus_gpa`, `inertia_cm4`, `extreme_fibre_mm`
- `support_type`, `support_a_m`, `support_b_m`
- `intervals` (100–10,000; default 1,000)
- `loads`: discriminated objects of type `point`, `udl` or `moment`

It returns reactions, flexural rigidity, integration constants, extrema and a `points` array with one result record per station.

The local telemetry endpoints and WebSocket are documented in [Live monitor prototype](#live-monitor-prototype).
