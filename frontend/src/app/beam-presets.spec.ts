import { REAL_WORLD_BEAM_PRESETS, instantiateBeamPreset, resetState } from './beam-presets';
import type { BeamPresetState } from './beam-presets';

describe('beam presets', () => {
  const presetIds = ['iphone-pocket', 'spaghetti', 'skateboard-deck', '747-wing-tip'];

  it('purges loads and support conditions before toggling between presets', () => {
    const state: BeamPresetState = {
      beam: {
        length_m: 6,
        youngs_modulus_gpa: 200,
        inertia_cm4: 5_000,
        extreme_fibre_mm: 100,
        support_type: 'fixed-fixed',
        support_a_m: 1,
        support_b_m: 5,
        intervals: 1_000
      },
      loads: [
        { id: 1, type: 'point', P: 20, x: 3 },
        { id: 2, type: 'udl', w1: 10, w2: 12, x1: 0, x2: 6 }
      ]
    };

    for (const id of presetIds) {
      resetState(state);
      expect(state.loads).toEqual([]);
      expect(state.beam.support_type).toBe('simply-supported');
      expect(state.beam.support_a_m).toBe(0);
      expect(state.beam.support_b_m).toBe(0);

      const preset = REAL_WORLD_BEAM_PRESETS.find(item => item.id === id)!;
      const instance = instantiateBeamPreset(preset);
      state.beam = { ...instance.beam };
      state.loads.push(...instance.loads);
      expect(state.loads.length).toBe(preset.loads.length);
      expect(state.loads.every(load => load.type === 'point' || load.type === 'udl' || load.type === 'moment')).toBeTrue();
    }
  });

  it('returns independent load records for each preset instance', () => {
    const preset = REAL_WORLD_BEAM_PRESETS.find(item => item.id === '747-wing-tip')!;
    const first = instantiateBeamPreset(preset);
    const second = instantiateBeamPreset(preset);
    const firstLoad = first.loads[0];
    const secondLoad = second.loads[0];
    expect(firstLoad).not.toBe(secondLoad);
    if (firstLoad.type === 'udl' && secondLoad.type === 'udl') {
      firstLoad.w1 = 0;
      expect(secondLoad.w1).toBe(-15);
      expect(preset.loads[0].type === 'udl' && preset.loads[0].w1).toBe(-15);
    }
  });

  it('exposes positive physical constants in SI-compatible units', () => {
    for (const id of presetIds) {
      const preset = REAL_WORLD_BEAM_PRESETS.find(item => item.id === id)!;
      const EPa = preset.beam.youngs_modulus_gpa * 1e9;
      const Im4 = preset.beam.inertia_cm4 * 1e-8;
      const cM = preset.beam.extreme_fibre_mm * 1e-3;
      const yieldPa = preset.yieldStrengthMpa * 1e6;

      expect(EPa).toBeGreaterThan(0);
      expect(Im4).toBeGreaterThan(0);
      expect(cM).toBeGreaterThan(0);
      expect(yieldPa).toBeGreaterThan(0);
    }
  });

  it('contains the expected real-world constants for the iPhone, spaghetti, skateboard, and 747 wing', () => {
    const iphone = REAL_WORLD_BEAM_PRESETS.find(item => item.id === 'iphone-pocket')!;
    const spaghetti = REAL_WORLD_BEAM_PRESETS.find(item => item.id === 'spaghetti')!;
    const skateboard = REAL_WORLD_BEAM_PRESETS.find(item => item.id === 'skateboard-deck')!;
    const wing = REAL_WORLD_BEAM_PRESETS.find(item => item.id === '747-wing-tip')!;

    expect(iphone.beam.youngs_modulus_gpa).toBe(69);
    expect(iphone.yieldStrengthMpa).toBe(214);
    expect(spaghetti.beam.youngs_modulus_gpa).toBe(3.5);
    expect(spaghetti.yieldStrengthMpa).toBe(35);
    expect(skateboard.beam.inertia_cm4).toBeCloseTo(2.88, 12);
    expect(wing.beam.inertia_cm4).toBe(35_000_000);
    expect(wing.yieldStrengthMpa).toBe(503);
  });
});
