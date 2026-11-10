import type { BeamProperties, BeamLoad } from './app.component';
import type { FailureMode } from './failure-renderer';

export type PresetLoad =
  | { type: 'point'; P: number; x: number }
  | { type: 'udl'; w1: number; w2: number; x1: number; x2: number }
  | { type: 'moment'; M: number; x: number };

export interface RealWorldBeamPreset {
  id: string;
  name: string;
  icon: string;
  objectSkin: 'iphone' | 'diving-board' | 'skateboard' | 'wing' | 'spaghetti';
  materialName: string;
  failureMode: FailureMode;
  beam: Omit<BeamProperties, 'intervals'> & { intervals?: number };
  yieldStrengthMpa: number;
  loads: PresetLoad[];
}

export interface BeamPresetState {
  beam: BeamProperties;
  loads: BeamLoad[];
}

/** Purges mutable load/support state before a preset is applied. */
export function resetState(state: BeamPresetState): void {
  state.loads.splice(0, state.loads.length);
  state.beam.support_type = 'simply-supported';
  state.beam.support_a_m = 0;
  state.beam.support_b_m = 0;
}

function clonePresetLoad(load: PresetLoad): PresetLoad {
  if (load.type === 'point') return { type: 'point', P: load.P, x: load.x };
  if (load.type === 'udl') return { type: 'udl', w1: load.w1, w2: load.w2, x1: load.x1, x2: load.x2 };
  return { type: 'moment', M: load.M, x: load.x };
}

function rectangleInertiaCm4(widthMm: number, heightMm: number): number {
  return widthMm * heightMm ** 3 / 12 / 10_000;
}

export const REAL_WORLD_BEAM_PRESETS: RealWorldBeamPreset[] = [
  {
    id: 'iphone-pocket',
    name: 'iPhone bend',
    icon: '📱',
    objectSkin: 'iphone',
    materialName: 'Aluminum 6063-T6',
    failureMode: 'ductile',
    beam: {
      length_m: 0.138,
      youngs_modulus_gpa: 69,
      inertia_cm4: rectangleInertiaCm4(67, 6.9),
      extreme_fibre_mm: 3.45,
      support_type: 'simply-supported',
      support_a_m: 0,
      support_b_m: 0.138
    },
    yieldStrengthMpa: 214,
    loads: [{ type: 'point', P: 0.31, x: 0.069 }]
  },
  {
    id: 'diving-board',
    name: 'Dive board',
    icon: '🏊',
    objectSkin: 'diving-board',
    materialName: 'Glass-fibre composite',
    failureMode: 'brittle',
    beam: {
      length_m: 4.8,
      youngs_modulus_gpa: 28,
      inertia_cm4: rectangleInertiaCm4(500, 40),
      extreme_fibre_mm: 20,
      support_type: 'cantilever-left',
      support_a_m: 0,
      support_b_m: 4.8
    },
    yieldStrengthMpa: 250,
    loads: [{ type: 'point', P: 1.8, x: 4.8 }]
  },
  {
    id: 'skateboard-deck',
    name: 'Skateboard',
    icon: '🛹',
    objectSkin: 'skateboard',
    materialName: 'Laminated hard maple',
    failureMode: 'brittle',
    beam: {
      length_m: 0.8,
      youngs_modulus_gpa: 12.5,
      inertia_cm4: rectangleInertiaCm4(200, 12),
      extreme_fibre_mm: 6,
      support_type: 'simply-supported',
      support_a_m: 0,
      support_b_m: 0.8
    },
    yieldStrengthMpa: 105,
    loads: [
      { type: 'point', P: 1.2, x: 0.28 },
      { type: 'point', P: 1.2, x: 0.52 }
    ]
  },
  {
    id: '747-wing-tip',
    name: '747 wing',
    icon: '✈️',
    objectSkin: 'wing',
    materialName: 'Aluminum 7075-T6',
    failureMode: 'ductile',
    beam: {
      length_m: 30,
      youngs_modulus_gpa: 71.7,
      inertia_cm4: 35_000_000,
      extreme_fibre_mm: 1000,
      support_type: 'cantilever-left',
      support_a_m: 0,
      support_b_m: 30
    },
    yieldStrengthMpa: 503,
    loads: [{ type: 'udl', w1: -15, w2: -45, x1: 0, x2: 30 }]
  },
  {
    id: 'spaghetti',
    name: 'Spaghetti',
    icon: '🍝',
    objectSkin: 'spaghetti',
    materialName: 'Dry durum wheat pasta',
    failureMode: 'brittle',
    beam: {
      length_m: 0.25,
      youngs_modulus_gpa: 3.5,
      inertia_cm4: Math.PI * 2 ** 4 / 64 / 10_000,
      extreme_fibre_mm: 1,
      support_type: 'simply-supported',
      support_a_m: 0,
      support_b_m: 0.25
    },
    yieldStrengthMpa: 35,
    loads: [{ type: 'point', P: 0.0003, x: 0.125 }]
  }
];

export function instantiateBeamPreset(
  preset: RealWorldBeamPreset,
  firstLoadId = 1
): { beam: BeamProperties; loads: BeamLoad[] } {
  return {
    beam: {
      ...preset.beam,
      intervals: 1000
    },
    loads: preset.loads.map((sourceLoad, index): BeamLoad => {
      const load = clonePresetLoad(sourceLoad);
      const id = firstLoadId + index;
      if (load.type === 'point') return { ...load, id };
      if (load.type === 'udl') return { ...load, id };
      return { ...load, id };
    })
  };
}
