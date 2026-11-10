export interface MaterialPreset {
  id: string;
  name: string;
  category: string;
  youngs_modulus_gpa: number;
  poisson_ratio: number;
  yield_strength_mpa: number;
  strength_kind: 'yield' | 'bending-reference';
  strength_basis: string;
  density_kg_m3: number;
  description: string;
  source_name: string;
  source_url: string;
}

export interface RosetteStrain {
  ex_micro: number;
  ey_micro: number;
  gamma_xy_micro: number;
}

export interface SpatialStrainNode {
  id: string;
  label: string;
  x_ratio: number;
  strain_input: RosetteStrain;
}

export interface MaterialStressEvaluation {
  stress_tensor: {
    sigma_x_mpa: number;
    sigma_y_mpa: number;
    tau_xy_mpa: number;
  };
  mohrs_circle: {
    center_mpa: number;
    radius_mpa: number;
    sigma_1_mpa: number;
    sigma_2_mpa: number;
    tau_max_mpa: number;
    principal_angle_deg: number;
  };
  material: {
    youngs_modulus_gpa: number;
    poisson_ratio: number;
    yield_strength_mpa: number;
    von_mises_mpa: number;
    factor_of_safety: number | null;
    warning_factor_of_safety: number;
  };
  alert: {
    level: 'NORMAL' | 'WARNING' | 'CRITICAL';
    message: string;
  };
}

export function deriveSpatialStrainNodes(strain: RosetteStrain): SpatialStrainNode[] {
  return [0, 0.25, 0.5, 0.75, 1].map((xRatio, index) => {
    const bendingFactor = Math.sin(Math.PI * xRatio);
    const shearFactor = Math.cos(Math.PI * xRatio);
    return {
      id: `R${index + 1}`,
      label: `Rosette ${index + 1} · ${Math.round(xRatio * 100)}% span`,
      x_ratio: xRatio,
      strain_input: {
        ex_micro: strain.ex_micro * bendingFactor,
        ey_micro: strain.ey_micro * bendingFactor,
        gamma_xy_micro: strain.gamma_xy_micro * shearFactor
      }
    };
  });
}

export function factorOfSafetyColor(factorOfSafety: number | null, warningThreshold: number): string {
  if (factorOfSafety === null || factorOfSafety >= warningThreshold) return '#166534';
  return factorOfSafety < 1 ? '#991b1b' : '#b45309';
}

export function calculateMaterialStress(
  strain: RosetteStrain,
  material: Pick<MaterialPreset, 'youngs_modulus_gpa' | 'poisson_ratio' | 'yield_strength_mpa' | 'strength_kind'>,
  warningFactorOfSafety: number
): MaterialStressEvaluation {
  const ex = strain.ex_micro * 1e-6;
  const ey = strain.ey_micro * 1e-6;
  const gammaXY = strain.gamma_xy_micro * 1e-6;
  const modulusMpa = material.youngs_modulus_gpa * 1000;
  const poissonRatio = material.poisson_ratio;
  const planeStressFactor = modulusMpa / (1 - poissonRatio ** 2);
  const sigmaX = planeStressFactor * (ex + poissonRatio * ey);
  const sigmaY = planeStressFactor * (ey + poissonRatio * ex);
  const tauXY = modulusMpa / (2 * (1 + poissonRatio)) * gammaXY;

  const center = (sigmaX + sigmaY) / 2;
  const radius = Math.hypot((sigmaX - sigmaY) / 2, tauXY);
  const sigma1 = center + radius;
  const sigma2 = center - radius;
  const vonMises = Math.sqrt(Math.max(
    0,
    sigmaX ** 2 - sigmaX * sigmaY + sigmaY ** 2 + 3 * tauXY ** 2
  ));
  const factorOfSafety = vonMises > 1e-12 ? material.yield_strength_mpa / vonMises : null;
  const strengthLabel = material.strength_kind === 'yield' ? 'Yield strength' : 'Bending-strength reference';

  let alertLevel: MaterialStressEvaluation['alert']['level'] = 'NORMAL';
  let alertMessage = factorOfSafety === null
    ? 'No equivalent stress detected; the strength-based factor of safety is unbounded.'
    : 'Operating within the configured strength-screening margin.';
  if (factorOfSafety !== null && factorOfSafety < 1) {
    alertLevel = 'CRITICAL';
    alertMessage = `${strengthLabel} exceeded: von Mises stress is ${vonMises.toFixed(2)} MPa against ${material.yield_strength_mpa.toFixed(2)} MPa.`;
  } else if (factorOfSafety !== null && factorOfSafety < warningFactorOfSafety) {
    alertLevel = 'WARNING';
    alertMessage = `Factor of safety is below the warning threshold (${factorOfSafety.toFixed(2)}).`;
  }

  return {
    stress_tensor: {
      sigma_x_mpa: sigmaX,
      sigma_y_mpa: sigmaY,
      tau_xy_mpa: tauXY
    },
    mohrs_circle: {
      center_mpa: center,
      radius_mpa: radius,
      sigma_1_mpa: sigma1,
      sigma_2_mpa: sigma2,
      tau_max_mpa: radius,
      principal_angle_deg: 0.5 * Math.atan2(2 * tauXY, sigmaX - sigmaY) * 180 / Math.PI
    },
    material: {
      youngs_modulus_gpa: material.youngs_modulus_gpa,
      poisson_ratio: poissonRatio,
      yield_strength_mpa: material.yield_strength_mpa,
      von_mises_mpa: vonMises,
      factor_of_safety: factorOfSafety,
      warning_factor_of_safety: warningFactorOfSafety
    },
    alert: { level: alertLevel, message: alertMessage }
  };
}
