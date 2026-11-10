// Position du soleil (algorithme NOAA simplifié, précision ~0,5°) et conversion
// vers une direction 3D dans le repère de la maquette. Aucune dépendance au DOM.

const RAD = Math.PI / 180;

/** Les 4 périodes proposées. `utc` = décalage de l'heure légale française ce jour-là. */
export const PERIODS = [
  { id: 'hiver', label: 'Hiver', date: '21 déc', day: 355, utc: 1 },
  { id: 'printemps', label: 'Printemps', date: '20 mars', day: 79, utc: 1 },
  { id: 'ete', label: 'Été', date: '21 juin', day: 172, utc: 2 },
  { id: 'automne', label: 'Automne', date: '22 sept', day: 265, utc: 2 },
];

/** Déclinaison (rad) et équation du temps (min) pour un jour de l'année. */
function solarParams(day, hourUtc = 12) {
  const g = ((2 * Math.PI) / 365) * (day - 1 + (hourUtc - 12) / 24);
  const eqTime =
    229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);
  return { decl, eqTime };
}

/**
 * @param {{day:number, hour:number, utc:number, lat:number, lon:number}} p
 *   hour = heure légale décimale, lon positive vers l'est
 * @returns {{altitude:number, azimuth:number}} degrés ; azimut compté depuis le nord, sens horaire
 */
export function solarPosition({ day, hour, utc, lat, lon }) {
  const { decl, eqTime } = solarParams(day, hour - utc);
  const trueSolarMin = hour * 60 + eqTime + 4 * lon - 60 * utc;
  const ha = (trueSolarMin / 4 - 180) * RAD;
  const phi = lat * RAD;
  const cosZ = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  const altitude = 90 - Math.acos(Math.max(-1, Math.min(1, cosZ))) / RAD;
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) / RAD + 180;
  return { altitude, azimuth: (az + 360) % 360 };
}

/** Lever, midi solaire et coucher en heure légale décimale (null si jour/nuit polaire). */
export function sunTimes({ day, utc, lat, lon }) {
  const { decl, eqTime } = solarParams(day);
  const phi = lat * RAD;
  const noonUtcMin = 720 - 4 * lon - eqTime;
  const noon = noonUtcMin / 60 + utc;
  const cosH = Math.cos(90.833 * RAD) / (Math.cos(phi) * Math.cos(decl)) - Math.tan(phi) * Math.tan(decl);
  if (cosH > 1) return { sunrise: null, sunset: null, noon, polar: 'nuit' };
  if (cosH < -1) return { sunrise: null, sunset: null, noon, polar: 'jour' };
  const h = Math.acos(cosH) / RAD; // degrés
  return { sunrise: noon - (4 * h) / 60, sunset: noon + (4 * h) / 60, noon, polar: null };
}

/**
 * Direction vers le soleil dans le repère de la maquette (Y vers le haut).
 * `planTopAzimuth` = azimut (depuis le nord, sens horaire) de la direction -Z,
 * c'est-à-dire du haut du plan vu de dessus.
 */
export function sunVector(altitude, azimuth, planTopAzimuth, target) {
  const d = (azimuth - planTopAzimuth) * RAD; // sens horaire vu de dessus, depuis -Z vers +X
  const h = altitude * RAD;
  return target.set(Math.cos(h) * Math.sin(d), Math.sin(h), -Math.cos(h) * Math.cos(d));
}

/** Azimut (depuis le nord, sens horaire) d'une direction horizontale du repère de la maquette. */
export function azimuthOf(x, z, planTopAzimuth) {
  return (((Math.atan2(x, -z) / RAD + planTopAzimuth) % 360) + 360) % 360;
}

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
export function cardinal(azimuth) {
  return CARDINALS[Math.round((((azimuth % 360) + 360) % 360) / 45) % 8];
}

export function formatHour(h) {
  const t = Math.round((((h % 24) + 24) % 24) * 60);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
