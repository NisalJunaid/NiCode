/**
 * Images attached to chat messages: pick (camera/library), shrink to what Claude can use
 * (long edge ≤ 1568 px, JPEG), and keep the base64 ready to send.
 */
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import type { ImageInput } from '@protocol';

export const MAX_IMAGES = 4;
const MAX_EDGE = 1568; // Claude downsizes anything larger anyway

export interface Attachment {
  /** Local file of the resized image (for thumbnails). */
  uri: string;
  width: number;
  height: number;
  image: ImageInput;
}

/** Resizes and re-encodes one image. */
export async function prepareImage(uri: string, width?: number, height?: number): Promise<Attachment> {
  const ctx = ImageManipulator.manipulate(uri);
  if (width && height && Math.max(width, height) > MAX_EDGE) ctx.resize(width >= height ? { width: MAX_EDGE } : { height: MAX_EDGE });
  const ref = await ctx.renderAsync();
  const out = await ref.saveAsync({ compress: 0.75, format: SaveFormat.JPEG, base64: true });
  return { uri: out.uri, width: out.width, height: out.height, image: { mediaType: 'image/jpeg', data: out.base64 ?? '' } };
}

/** Opens the camera or the photo library. Returns [] if cancelled or permission was refused. */
export async function pickImages(source: 'camera' | 'library', limit: number): Promise<Attachment[]> {
  if (limit <= 0) return [];
  let result: ImagePicker.ImagePickerResult;
  if (source === 'camera') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new Error('Camera permission is off. Allow it in system settings to take photos.');
    result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 });
  } else {
    result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: limit, quality: 1 });
  }
  if (result.canceled) return [];
  const picked = result.assets.slice(0, limit);
  return Promise.all(picked.map((a) => prepareImage(a.uri, a.width, a.height)));
}

// Thumbnails of images sent from this phone, by session + user-turn index (memory only;
// history from the server only knows how many images a turn had).
const sent = new Map<string, string[]>();
export function rememberSent(sessionId: string, turn: number, uris: string[]): void {
  if (uris.length) sent.set(`${sessionId}:${turn}`, uris);
}
export function sentThumbnails(sessionId: string | null | undefined, turn: number): string[] {
  return (sessionId && sent.get(`${sessionId}:${turn}`)) || [];
}
