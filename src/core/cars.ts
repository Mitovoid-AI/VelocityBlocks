// Car body styles the driver can pick. Purely visual: every body uses the same physics.
// Dependency-free so storage, the UI and node tests can import it without three.js.

export type CarBody = 'racer' | 'buggy' | 'muscle' | 'formula';

export interface CarBodyInfo {
  readonly id: CarBody;
  readonly name: string;
  readonly blurb: string;
  /** SVG path for a 64x24 viewBox, nose to the right. Wheels are drawn separately at cx 16 and 46, cy 19, r 5. */
  readonly icon: string;
}

export const CAR_BODIES: readonly CarBodyInfo[] = [
  { id: 'racer', name: 'Racer', blurb: 'Low wedge, big rear wing', icon: 'M4 17 L5 12 L12 11 L14 6 L19 6 L19 10 L30 9 L38 6 L44 6 L50 10 L60 13 L61 17 Z' },
  { id: 'buggy', name: 'Buggy', blurb: 'Open roll cage, chunky fenders', icon: 'M5 17 L6 12 L14 12 L20 4 L36 4 L40 11 L56 12 L59 17 Z' },
  { id: 'muscle', name: 'Muscle', blurb: 'Long bonnet, fastback roof', icon: 'M3 17 L3 12 L14 11 L22 6 L36 6 L42 11 L60 12 L61 17 Z' },
  {
    id: 'formula',
    name: 'Formula',
    blurb: 'Open wheels, wings front and rear',
    icon: 'M2 4 L11 4 L11 7 L8 8 L8 11 L22 10 L24 6 L28 6 L29 8 L31 7 L34 8 L37 11 L48 12 L57 14 L60 15 L63 15 L63 18 L52 18 L52 16 L44 13.5 L38 13.5 L38 17 L8 17 L8 14 L2 14 Z',
  },
];

export const CAR_BODY_NOTE = 'Looks only: every body drives the same.';

export const DEFAULT_CAR_BODY: CarBody = 'racer';

export function isCarBody(v: unknown): v is CarBody {
  return CAR_BODIES.some((b) => b.id === v);
}
