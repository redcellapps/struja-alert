// Static configuration for the EDS (Elektrodistribucija Srbije) data source.
// See SPEC §1. Slugs and the max value of {N} must be verified empirically in Phase 1.

export const BASE = "https://elektrodistribucija.rs";

// URL templates. {City} and {N} are substituted; Belgrade omits the {City} segment.
export const URL_SRBIJA = (city, n) =>
  `${BASE}/planirana-iskljucenja-srbija/${city}_Dan_${n}_Iskljucenja.htm`;
export const URL_BEOGRAD = (n) =>
  `${BASE}/planirana-iskljucenja-beograd/Dan_${n}_Iskljucenja.htm`;

// {N} = 0 (today) .. 3 (three days ahead). Upper bound to be confirmed in Phase 1.
export const DAYS = [0, 1, 2, 3];

// Confirmed slugs; the rest are candidates to verify by crawling the index page (SPEC §1, §9).
export const CITY_SLUGS = ["Nis", "Kraljevo"];

// MVP targets Niš only.
export const MVP_CITY = "Nis";

// Politeness: identify the app + a contact address (SPEC §1 "Politeness").
export const CONTACT_EMAIL = "lanche1990@gmail.com";
export const USER_AGENT = `StrujaAlert/0.1 (+data spike; ${CONTACT_EMAIL})`;
