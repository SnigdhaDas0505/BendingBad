import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { REAL_WORLD_BEAM_PRESETS, instantiateBeamPreset } from '../src/app/beam-presets.ts';

describe('illustrative beam presets', () => {
  it('provides all requested scenarios with valid beam and strength values', () => {
    assert.deepEqual(
      REAL_WORLD_BEAM_PRESETS.map(preset => preset.id),
      ['iphone-pocket', 'diving-board', 'skateboard-deck', '747-wing-tip', 'spaghetti']
    );

    for (const preset of REAL_WORLD_BEAM_PRESETS) {
      assert.ok(preset.beam.length_m > 0, preset.id);
      assert.ok(preset.beam.youngs_modulus_gpa > 0, preset.id);
      assert.ok(preset.beam.inertia_cm4 > 0, preset.id);
      assert.ok(preset.beam.extreme_fibre_mm > 0, preset.id);
      assert.ok(preset.yieldStrengthMpa > 0, preset.id);
      assert.ok(preset.loads.length > 0, preset.id);
      assert.ok(preset.materialName.length > 0, preset.id);
      assert.ok(preset.icon.length > 0, preset.id);
      assert.ok(preset.objectSkin !== 'beam', preset.id);
    }
  });

  it('converts the supplied iPhone force from newtons to the solver kN unit', () => {
    const preset = REAL_WORLD_BEAM_PRESETS.find(item => item.id === 'iphone-pocket');
    assert.ok(preset);
    assert.equal(preset.loads[0].type, 'point');
    if (preset.loads[0].type !== 'point') return;
    assert.equal(preset.loads[0].P, 0.31);
    assert.equal(preset.beam.youngs_modulus_gpa, 69);
    assert.equal(preset.yieldStrengthMpa, 214);
  });

  it('uses the requested dimensions, strengths, and representative load shapes', () => {
    const divingBoard = REAL_WORLD_BEAM_PRESETS.find(item => item.id === 'diving-board');
    const skateboard = REAL_WORLD_BEAM_PRESETS.find(item => item.id === 'skateboard-deck');
    const wing = REAL_WORLD_BEAM_PRESETS.find(item => item.id === '747-wing-tip');
    const spaghetti = REAL_WORLD_BEAM_PRESETS.find(item => item.id === 'spaghetti');

    assert.ok(divingBoard && skateboard && wing && spaghetti);
    assert.equal(divingBoard.beam.length_m, 4.8);
    assert.equal(divingBoard.beam.youngs_modulus_gpa, 28);
    assert.equal(divingBoard.yieldStrengthMpa, 250);
    assert.deepEqual(divingBoard.loads, [{ type: 'point', P: 1.8, x: 4.8 }]);
    assert.equal(skateboard.beam.youngs_modulus_gpa, 12.5);
    assert.equal(skateboard.yieldStrengthMpa, 105);
    assert.deepEqual(skateboard.loads.map(load => load.type === 'point' ? load.P : 0), [1.2, 1.2]);
    assert.equal(wing.beam.youngs_modulus_gpa, 71.7);
    assert.equal(wing.yieldStrengthMpa, 503);
    assert.deepEqual(wing.loads, [{ type: 'udl', w1: -15, w2: -45, x1: 0, x2: 30 }]);
    assert.equal(spaghetti.beam.youngs_modulus_gpa, 3.5);
    assert.equal(spaghetti.yieldStrengthMpa, 35);
    assert.deepEqual(spaghetti.loads, [{ type: 'point', P: 0.0003, x: 0.125 }]);
    assert.ok(spaghetti.beam.inertia_cm4 < 0.001);
  });

  it('keeps object loads in the solver units and yields plausible elastic screening values', () => {
    const iphone = REAL_WORLD_BEAM_PRESETS.find(item => item.id === 'iphone-pocket');
    const skateboard = REAL_WORLD_BEAM_PRESETS.find(item => item.id === 'skateboard-deck');
    const wing = REAL_WORLD_BEAM_PRESETS.find(item => item.id === '747-wing-tip');
    const spaghetti = REAL_WORLD_BEAM_PRESETS.find(item => item.id === 'spaghetti');
    assert.ok(iphone && skateboard && wing && spaghetti);

    const stressMpa = (momentKNm: number, fibreMm: number, inertiaCm4: number): number =>
      momentKNm * 100 * fibreMm / inertiaCm4;
    const phoneMoment = iphone.loads[0].type === 'point'
      ? iphone.loads[0].P * iphone.beam.length_m / 4
      : 0;
    const pastaLoad = spaghetti.loads[0];
    assert.equal(pastaLoad.type, 'point');
    if (pastaLoad.type !== 'point') return;
    const pastaMoment = pastaLoad.P * spaghetti.beam.length_m / 4;
    const pastaRigidity = spaghetti.beam.youngs_modulus_gpa * spaghetti.beam.inertia_cm4 * 0.01;
    const pastaDeflectionMm = pastaLoad.P * spaghetti.beam.length_m ** 3 / (48 * pastaRigidity) * 1000;

    assert.ok(Math.abs(stressMpa(phoneMoment, iphone.beam.extreme_fibre_mm, iphone.beam.inertia_cm4) - 20.1) < 0.3);
    assert.ok(Math.abs(stressMpa(0.336, skateboard.beam.extreme_fibre_mm, skateboard.beam.inertia_cm4) - 70) < 0.1);
    assert.ok(Math.abs(stressMpa(pastaMoment, spaghetti.beam.extreme_fibre_mm, spaghetti.beam.inertia_cm4) - 23.9) < 0.2);
    assert.ok(pastaDeflectionMm > 30 && pastaDeflectionMm < 40);
    assert.ok(wing.loads[0].type === 'udl' && wing.loads[0].w1 < 0 && wing.loads[0].w2 < 0);
  });

  it('instantiates safe solver inputs and unique load ids for each case', () => {
    for (const preset of REAL_WORLD_BEAM_PRESETS) {
      const instance = instantiateBeamPreset(preset, 20);
      assert.equal(instance.beam.intervals, 1000);
      assert.deepEqual(instance.loads.map(load => load.id), preset.loads.map((_, index) => 20 + index));
      for (const load of instance.loads) {
        if (load.type === 'point' || load.type === 'moment') {
          assert.ok(load.x >= 0 && load.x <= instance.beam.length_m, preset.id);
        } else {
          assert.ok(load.x1 >= 0 && load.x1 < load.x2 && load.x2 <= instance.beam.length_m, preset.id);
        }
      }
    }
  });

  it('marks brittle and ductile examples explicitly', () => {
    assert.equal(REAL_WORLD_BEAM_PRESETS.find(item => item.id === 'iphone-pocket')?.failureMode, 'ductile');
    assert.equal(REAL_WORLD_BEAM_PRESETS.find(item => item.id === '747-wing-tip')?.failureMode, 'ductile');
    assert.equal(REAL_WORLD_BEAM_PRESETS.find(item => item.id === 'diving-board')?.failureMode, 'brittle');
    assert.equal(REAL_WORLD_BEAM_PRESETS.find(item => item.id === 'skateboard-deck')?.failureMode, 'brittle');
    assert.equal(REAL_WORLD_BEAM_PRESETS.find(item => item.id === 'spaghetti')?.failureMode, 'brittle');
  });
});
