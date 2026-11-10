"""Representative material values for the live telemetry demonstration."""

from __future__ import annotations

from typing import Any


_MATERIALS: tuple[dict[str, Any], ...] = (
    {
        "id": "steel_a36",
        "name": "Steel A36",
        "category": "Carbon steel",
        "youngs_modulus_gpa": 200.0,
        "poisson_ratio": 0.26,
        "yield_strength_mpa": 250.0,
        "strength_kind": "yield",
        "strength_basis": "Representative minimum yield strength; confirm the applicable ASTM A36/A36M edition and product specification.",
        "density_kg_m3": 7850.0,
        "description": "Representative structural steel properties.",
        "source_name": "MatWeb A36 material search",
        "source_url": "https://www.matweb.com/search/QuickText.aspx?SearchText=ASTM+A36",
    },
    {
        "id": "aluminum_6061_t6",
        "name": "Aluminum 6061-T6",
        "category": "Aluminum alloy",
        "youngs_modulus_gpa": 68.9,
        "poisson_ratio": 0.33,
        "yield_strength_mpa": 276.0,
        "strength_kind": "yield",
        "strength_basis": "Representative 6061-T6 yield value; minimum strength depends on product form, thickness, and applicable specification.",
        "density_kg_m3": 2700.0,
        "description": "Representative 6061-T6 properties; product form affects specified minimum strength.",
        "source_name": "MatWeb 6061-T6 material search",
        "source_url": "https://www.matweb.com/search/QuickText.aspx?SearchText=6061-T6",
    },
    {
        "id": "titanium_grade_5",
        "name": "Titanium Grade 5 (Ti-6Al-4V)",
        "category": "Titanium alloy",
        "youngs_modulus_gpa": 113.8,
        "poisson_ratio": 0.34,
        "yield_strength_mpa": 880.0,
        "strength_kind": "yield",
        "strength_basis": "Representative annealed Grade 5 value; specified minimum varies by product form, condition, and governing specification.",
        "density_kg_m3": 4430.0,
        "description": "Representative annealed Ti-6Al-4V properties.",
        "source_name": "MatWeb Ti-6Al-4V material search",
        "source_url": "https://www.matweb.com/search/QuickText.aspx?SearchText=Ti-6Al-4V",
    },
    {
        "id": "structural_timber",
        "name": "Structural Timber (Douglas Fir)",
        "category": "Wood",
        "youngs_modulus_gpa": 11.0,
        "poisson_ratio": 0.29,
        "yield_strength_mpa": 40.0,
        "strength_kind": "bending-reference",
        "strength_basis": "Illustrative bending-strength screening proxy only; timber is anisotropic and grade, moisture, species, and loading direction govern design values.",
        "density_kg_m3": 530.0,
        "description": "Illustrative along-grain Douglas Fir model; not a standardized yield-strength value.",
        "source_name": "USDA Forest Products Laboratory Wood Handbook",
        "source_url": "https://www.fpl.fs.usda.gov/documnts/fplgtr/fpl_gtr190.pdf",
    },
)


def list_material_presets() -> list[dict[str, Any]]:
    """Return a copy of the bundled material catalog for clients."""
    return [dict(material) for material in _MATERIALS]
