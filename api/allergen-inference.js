'use strict';
/**
 * Allergen inference — two tiers, by design:
 *
 *  Tier A (name_keyword): the allergen word appears directly in the name,
 *    e.g. "لبن جاف" or "Shrimp Alfredo" (shrimp -> shellfish). High
 *    confidence, but on its own this is exactly the gap a real clinician
 *    flagged: "Chicken Alfredo Parmesan" contains dairy and nothing in
 *    the name says milk, cheese, or cream.
 *
 *  Tier B (inferred_pattern): a curated list of dish/sauce/preparation
 *    names that imply an allergen even when the name doesn't say it —
 *    alfredo and parmesan imply dairy, بشاميل implies dairy+wheat,
 *    مايونيز implies egg, تمبورة/بريدد implies wheat, and so on. This is
 *    exactly the layer that catches the Alfredo case.
 *
 * Neither tier is treated as ground truth. Every tag this script writes
 * marks the food's allergen_profile_status as INFERRED_PENDING_REVIEW,
 * never VERIFIED — a clinician still has to confirm it (see the
 * ALLERGEN_PROFILE_REVIEW queue). A food that gets zero tags stays
 * UNKNOWN and keeps the existing fail-safe behaviour (excluded whenever
 * a client has a HARD allergen constraint), because zero tags could mean
 * "genuinely allergen-free" or "not yet inferred" and this script cannot
 * tell those apart.
 *
 * A positive tag from EITHER tier always blocks a matching hard
 * constraint immediately, with no verification wait — inference only
 * ever adds exclusions, never removes them, so acting on it immediately
 * cannot make anything less safe than the pre-inference state.
 *
 * Arabic word-boundary note: plain substring/regex matching on Arabic
 * text is dangerous — "أبيض" (white) contains "بيض" (egg) as a raw
 * substring, so a naive /بيض/ test would wrongly tag "أرز أبيض" (white
 * rice) as containing egg. Every Arabic keyword below is wrapped with
 * buildArabicPattern(), which requires the match to sit on a real word
 * boundary (allowing common Arabic prefixes/suffixes), the same fix
 * already applied to the food_role classifier earlier in this project.
 */

const SEP    = '(?:^|[\\s\\(\\)\\[\\]،,.\\-/+&|]|$)';
const PREFIX = '(?:ال|بال|وال|فال|لل|بـ|و|ب|ل)?';
const SUFFIX = '(?:ة|ات|ين|ه)?';
const _cache = new Map();

function arabicWord(word) {
  if (!_cache.has(word)) {
    _cache.set(word, new RegExp(`(?:^|[\\s(){}\\[\\],.\\-/+&|])${PREFIX}${word}${SUFFIX}(?=[\\s(){}\\[\\],.\\-/+&|]|$)`, 'i'));
  }
  return _cache.get(word);
}

// English/Latin terms use plain \b word boundaries (no Arabic clitic issue).
function latinWord(pattern) {
  return new RegExp(pattern, 'i');
}

function any(hay, patterns) { return patterns.some(p => p.test(hay)); }

const TIER_A = [
  // Arabic terms go through arabicWord() for safe boundaries; Latin terms
  // are plain regexes already anchored with \b in their source pattern.
  { allergen: 'milk', ar: ['لبن','حليب','جبن[ةه]?','قشط[ةه]','زبادي','زبد[ةه]','لبن[ةه]','كريم[ةه]?','كاسيين'],
    en: [/\bmilk\b/i,/\bcheese\b/i,/\bcream\b/i,/\byog?h?urt\b/i,/\bbutter\b/i,/\bdairy\b/i,/\bwhey\b/i,/\bcasein\b/i] },
  { allergen: 'shellfish', ar: ['جمبري','قريدس','روبيان','كابوريا'],
    en: [/\bshrimp\b/i,/\bprawn\b/i,/\bshellfish\b/i,/\bcrab\b/i,/\blobster\b/i] },
  { allergen: 'peanut', ar: ['فول سوداني'], en: [/\bpeanut\b/i] },
  { allergen: 'tree_nut', ar: ['مكسرات','لوز','كاجو','فستق','بندق','جوز','عين جمل'],
    en: [/\balmond\b/i,/\bcashew\b/i,/\bpistachio\b/i,/\bwalnut\b/i,/\bhazelnut\b/i,/\bpecan\b/i,/\bmacadamia\b/i,/\btree nut\b/i] },
  { allergen: 'egg', ar: ['بيض[ةه]?'], en: [/\begg\b/i,/\bmayonnaise\b/i,/\bmayo\b/i] },
  { allergen: 'gluten', ar: ['قمح','جلوتين','بقسماط'], en: [/\bwheat\b/i,/\bgluten\b/i,/\bbreaded\b/i,/\bcrumbs\b/i,/\bbatter\b/i] },
  { allergen: 'fish', ar: ['سمك','تونة','سالمون','بلطي'], en: [/\bfish\b/i,/\btuna\b/i,/\bsalmon\b/i,/\btilapia\b/i,/\banchov/i] },
  { allergen: 'soy', ar: ['صوي[اه]'], en: [/\bsoy\b/i,/\btofu\b/i,/\bedamame\b/i] },
  { allergen: 'sesame', ar: ['سمسم','طحين[ةه]'], en: [/\bsesame\b/i,/\btahini\b/i] },
];

// The critical tier: names that don't mention the allergen but strongly
// imply it through a well-known dish/sauce/preparation.
const TIER_B = [
  { allergens: ['milk'], ar: ['الفريدو','ألفريدو'], en: [/\balfredo\b/i] },
  { allergens: ['milk'], ar: ['بارميزان','موزاريلا','شيدر','ريكوتا','هالومي'],
    en: [/\bparmesan\b/i,/\bmozzarella\b/i,/\bcheddar\b/i,/\bfeta\b/i,/\bricotta\b/i,/\bhalloumi\b/i] },
  { allergens: ['milk','gluten'], ar: ['بشاميل'], en: [/\bb[eé]chamel\b/i] },
  { allergens: ['milk','egg'], ar: ['كاربونارا'], en: [/\bcarbonara\b/i] },
  { allergens: ['milk','egg','fish'], ar: ['سيزر'], en: [/\bcaesar\b/i] },
  { allergens: ['milk'], ar: ['رانش'], en: [/\branch dressing\b/i,/\branch\b/i] },
  { allergens: ['milk','tree_nut'], ar: ['بيستو'], en: [/\bpesto\b/i] },
  { allergens: ['milk','egg'], ar: ['كسترد','بودينج'], en: [/\bcustard\b/i,/\bpudding\b/i] },
  { allergens: ['milk','egg','gluten'], ar: ['تيراميسو','تشيز كيك'], en: [/\btiramisu\b/i,/\bcheesecake\b/i] },
  { allergens: ['gluten','milk','egg'], ar: ['كرواسون','دونات','كيك','بسكويت','وافل','بان كيك'],
    en: [/\bcroissant\b/i,/\bdonut\b/i,/\bcake\b/i,/\bcookie\b/i,/\bwaffle\b/i,/\bpancake\b/i] },
  { allergens: ['gluten'], ar: ['معجنات','فطير[ةه]','عجين[ةه]'], en: [/\bpastry\b/i,/\bdough\b/i] },
  { allergens: ['gluten'], ar: ['تمبورة','كرسبي'], en: [/\btempura\b/i,/\bcrispy chicken\b/i,/\bfried chicken\b.*\bbreaded\b/i] },
  { allergens: ['sesame'], ar: ['طحين[ةه]'], en: [] },
  { allergens: ['milk','gluten','tree_nut'], ar: ['كنافة','بسبوسة','بقلاوة'], en: [/\bkunafa\b/i,/\bbaklava\b/i,/\bbasbousa\b/i] },
];

function inferAllergens(nameAr, nameEn, brand) {
  const arHay = [nameAr, brand].filter(Boolean).join(' ');
  const enHay = [nameEn, brand].filter(Boolean).join(' ');
  const hits = new Map(); // allergen -> confidence

  for (const rule of TIER_A) {
    const matched = rule.ar.some(w => arabicWord(w).test(arHay)) || rule.en.some(re => re.test(enHay));
    if (matched) hits.set(rule.allergen, hits.get(rule.allergen) || 'name_keyword');
  }
  for (const rule of TIER_B) {
    const matched = rule.ar.some(w => arabicWord(w).test(arHay)) || rule.en.some(re => re.test(enHay));
    if (matched) for (const a of rule.allergens) if (!hits.has(a)) hits.set(a, 'inferred_pattern');
  }
  return hits; // Map<allergen, confidence>
}

module.exports = { inferAllergens, TIER_A, TIER_B, arabicWord };
