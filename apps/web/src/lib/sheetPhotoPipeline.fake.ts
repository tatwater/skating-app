/**
 * What `vi.mock('../components/photoPipeline', () => import('./sheetPhotoPipeline.fake'))` stands in
 * for the sheet's persistence tests: canvas and WASM do not run in jsdom. **It imports nothing** — a
 * mock factory that reaches a module importing the mocked one waits on itself, and the test run hangs.
 */

export async function processPhoto(file: File) {
  return {
    full: file,
    thumb: new File(['thumb'], `thumb-${file.name}`, { type: 'image/jpeg' }),
    coord: { lat: 44.5, lng: -73.2 },
    takenAtMs: 1_000,
  };
}
