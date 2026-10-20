// Floating profile-photo badge above a car: a sprite offset along world up, so it stays
// upright when the car rolls or flips. Drawing and image decoding live in ui/avatarArt.

import * as THREE from 'three';
import { isPhotoDataUrl } from '../core/photo';
import { drawAvatar, loadAvatarImage, peekAvatarImage } from '../ui/avatarArt';

/** Badge canvas edge in px (power of two for mipmaps; about 100 device px at most on screen). */
export const AVATAR_TEX = 128;
/** Sprite edge in metres. */
export const AVATAR_SIZE = 0.9;
/** Badge centre above the car's centre of mass, in metres. Clears the racer endplates (0.92). */
export const AVATAR_LIFT = 1.55;
export const AVATAR_BOB_AMP = 0.05;
/** Room between a body's top and the badge centre: half the badge, its bob and a 0.1 m gap. */
export const AVATAR_CLEARANCE = AVATAR_SIZE / 2 + AVATAR_BOB_AMP + 0.1;

/**
 * Badge lift for a vehicle whose body reaches `top` above its centre: the car's lift unless the body
 * is taller than a car's (the truck's cab and box), so the badge never sits inside it.
 */
export function avatarLift(top: number): number {
  return Math.max(AVATAR_LIFT, top + AVATAR_CLEARANCE);
}
/** Bob rate in rad/s. */
export const AVATAR_BOB_RATE = 2.4;
export const GHOST_AVATAR_OPACITY = 0.5;
export const GHOST_AVATAR_TINT = 0xbfe6ff;
/** The PB ghost's badge fades in linearly between these distances (m) so it never flickers. */
export const GHOST_FADE_NEAR = 8;
export const GHOST_FADE_FAR = 14;

export interface AvatarSpec {
  photo: string | null;
  /** Ring colour, normally the car colour. */
  ring: string;
  /** Ghost badge: half opacity and a blue tint. */
  dim?: boolean;
}

export class AvatarBadge {
  readonly sprite: THREE.Sprite;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly material: THREE.SpriteMaterial;
  private readonly baseOpacity: number;
  private readonly phase: number;
  private ring: string;
  private photo: string | null | undefined = undefined;
  private img: HTMLImageElement | null = null;
  private token = 0;
  private fade = 1;
  private disposed = false;

  /** `lift`: badge centre above the vehicle's centre (avatarLift). */
  constructor(
    spec: AvatarSpec,
    private readonly lift = AVATAR_LIFT,
  ) {
    // Ring first: setPhoto below draws straight away.
    this.ring = spec.ring;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = AVATAR_TEX;
    this.g = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.name = 'avatar';
    this.baseOpacity = spec.dim ? GHOST_AVATAR_OPACITY : 1;
    // depthTest so walls hide it with its car; no depthWrite so it never cuts holes in smoke
    // or the ghost; toneMapped off so tone mapping doesn't wash out skin tones.
    this.material = new THREE.SpriteMaterial({
      map: this.texture,
      transparent: true,
      opacity: this.baseOpacity,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
      sizeAttenuation: true,
    });
    if (spec.dim) this.material.color.setHex(GHOST_AVATAR_TINT);
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.scale.set(AVATAR_SIZE, AVATAR_SIZE, 1);
    this.sprite.renderOrder = 1; // after other transparents, so the photo stays readable
    this.sprite.name = 'avatar';
    // The ghost bobs in counter-phase so the two badges don't move in lockstep.
    this.phase = spec.dim ? Math.PI : 0;
    this.setPhoto(spec.photo);
  }

  /** Show a photo (data URL) or the dummy for null/invalid. Decoding is async; the dummy shows meanwhile. */
  setPhoto(photo: string | null): void {
    const url = isPhotoDataUrl(photo) ? photo : null;
    if (url === this.photo) return;
    this.photo = url;
    const t = ++this.token;
    this.img = url ? peekAvatarImage(url) : null;
    this.redraw();
    if (url && !this.img) {
      void loadAvatarImage(url).then((im) => {
        if (this.disposed || t !== this.token || !im) return;
        this.img = im;
        this.redraw();
      });
    }
  }

  setRing(color: string): void {
    if (color === this.ring) return;
    this.ring = color;
    this.redraw();
  }

  /** Opacity multiplier 0..1 (a uniform change only, no shader recompile). */
  setFade(k: number): void {
    if (k === this.fade) return;
    this.fade = k;
    this.material.opacity = this.baseOpacity * k;
  }

  /** Centre the badge above a car centre at (x, y, z); t in seconds drives the bob. */
  place(x: number, y: number, z: number, t: number): void {
    this.sprite.position.set(x, y + this.lift + Math.sin(t * AVATAR_BOB_RATE + this.phase) * AVATAR_BOB_AMP, z);
  }

  dispose(): void {
    this.disposed = true;
    this.token++;
    this.texture.dispose();
    this.material.dispose();
    // sprite.geometry is a module-level quad shared by every Sprite: never dispose it.
  }

  private redraw(): void {
    if (this.disposed) return;
    try {
      drawAvatar(this.g, AVATAR_TEX, this.img, this.ring);
    } catch {
      // A broken image must not take the badge down: fall back to the dummy.
      this.img = null;
      drawAvatar(this.g, AVATAR_TEX, null, this.ring);
    }
    this.texture.needsUpdate = true;
  }
}
