/**
 * Whether the shell must add web-renderer drag regions for the window chrome.
 * macOS keeps its native hidden-inset title bar, so web drag regions would
 * add an unnecessary hand-cursor hit area to the renderer.
 * @param platform - operating-system platform reported by Node.js.
 * @returns true only when the frameless Windows shell needs custom drag chrome.
 */
export function shouldInstallWindowDragChrome(platform: NodeJS.Platform): boolean {
  return platform === 'win32'
}
