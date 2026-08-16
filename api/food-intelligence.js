'use strict';

function normalizeText(v) {
  return String(v || '').trim().toLowerCase();
}

function normalizeAllergen(v) {
  const x = normalizeText(v);
  const aliases = {
    'لبن': 'milk', 'حليب': 'milk', 'dairy': 'milk', 'milk': 'milk',
    'جبنة': 'milk', 'cheese': 'milk',
    'جمبري': 'shellfish', 'shrimp': 'shellfish', 'shellfish': 'shellfish',
    'فول سوداني': 'peanut', 'peanut': 'peanut',
    'مكسرات': 'tree_nut', 'tree nuts': 'tree_nut', 'tree_nut': 'tree_nut',
    'بيض': 'egg', 'egg': 'egg',
    'قمح': 'wheat', 'wheat': 'wheat', 'gluten': 'gluten',
    'سمك': 'fish', 'fish': 'fish',
    'صويا': 'soy', 'soy': 'soy',
    'سمسم': 'sesame', 'sesame': 'sesame'
  };
  return aliases[x] || x;
}

function explicitExclusionKinds() {
  return new Set(['allergy','medical','religious']);
}

function isHardConstraint(kind, severity='HARD') {
  return severity === 'HARD' || explicitExclusionKinds().has(kind);
}

module.exports = { normalizeText, normalizeAllergen, explicitExclusionKinds, isHardConstraint };
