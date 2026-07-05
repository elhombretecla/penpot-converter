declare module '@penpot/library' {
  /**
   * Official Penpot file builder (ClojureScript compiled to JS, MPL-2.0).
   * Only the API surface we use is typed here; params are open maps that
   * follow Penpot's shape attribute model (camelCase keys).
   */
  export interface BuildContext {
    currentFileId: string;
    currentPageId: string;
    addFile(params: { name: string; id?: string; [k: string]: unknown }): string;
    closeFile(): void;
    addPage(params: { name: string; id?: string; [k: string]: unknown }): string;
    closePage(): void;
    addBoard(params: Record<string, unknown>): string;
    closeBoard(): void;
    addGroup(params: Record<string, unknown>): string;
    closeGroup(): void;
    addBool(params: Record<string, unknown>): string;
    closeBool(): void;
    addRect(params: Record<string, unknown>): string;
    addCircle(params: Record<string, unknown>): string;
    addPath(params: Record<string, unknown>): string;
    addText(params: Record<string, unknown>): string;
    addLibraryColor(params: Record<string, unknown>): string;
    addLibraryTypography(params: Record<string, unknown>): string;
    addComponent(params: Record<string, unknown>): string;
    addComponentInstance(params: Record<string, unknown>): string;
    addFileMedia(params: Record<string, unknown>, blob: Blob | Uint8Array): string;
    getMediaAsImage(mediaId: string): Record<string, unknown>;
    addTokensLib(params: Record<string, unknown>): void;
    addRelation(fileId: string, libraryId: string): void;
    genId(): string;
    [k: string]: unknown;
  }

  export class BuilderError extends Error {
    type: string;
    code: string;
  }

  export function createBuildContext(): BuildContext;
  export function exportStream(context: BuildContext, writable: WritableStream): Promise<void>;
  export function exportAsBytes(context: BuildContext): Promise<Uint8Array>;
  export function exportAsBlob(context: BuildContext): Promise<Blob>;
}
