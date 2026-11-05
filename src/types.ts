export type Brightness = {
  percent: number;
  current: number;
  minimum: number;
  maximum: number;
  method: string;
};

export type Monitor = {
  id: string;
  name: string;
  display: string;
  brightness: Brightness | null;
  error: string | null;
};

export interface DisplayBackend {
  list(): Promise<Monitor[]>;
  get(monitorId: string): Promise<Brightness>;
  set(monitorId: string, percent: number): Promise<Brightness>;
}

export type Settings = {
  monitorId?: string;
  monitorName?: string;
  step?: number;
  pressStep?: number;
  preset?: number;
};

export const clamp = (value: number): number => Math.max(0, Math.min(100, value));
export function bounded(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
}

export function settingsOf(input: Settings): Required<Settings> {
  return {
    monitorId: typeof input.monitorId === "string" ? input.monitorId : "",
    monitorName: typeof input.monitorName === "string" ? input.monitorName : "Display",
    step: bounded(input.step, 2, 1, 20),
    pressStep: bounded(input.pressStep, 10, 1, 25),
    preset: bounded(input.preset, 50, 0, 100),
  };
}
