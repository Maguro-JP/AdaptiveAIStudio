/** 画面側の素の JS に、型だけ添える。中身は blocks-core.js が持つ。 */
export type PortType = 'num' | 'text' | 'bool' | 'list' | 'any';
export interface Ref { ref: string; port: string }
export interface Node { id: string; kind: string; x: number; y: number; values: Record<string, any> }
export interface Link { from: { node: string; port: string }; to: { node: string; port: string } }
export interface Graph { version: number; nodes: Node[]; links: Link[] }
export interface Step { id: string; kind: string; values: Record<string, any>; body?: Step[]; yes?: Step[]; no?: Step[] }
export interface Workflow { version: number; trigger: { kind: string; time?: string; folder?: string }; steps: Step[] }
export interface Problem { node: string; message: string }
export interface Runtime { show: (v: unknown, id: string) => void; at?: (id: string) => void; readFile?: (n: string) => Promise<string>; writeFile?: (n: string, t: string) => Promise<void>; weather?: (p: string, d: number) => Promise<{ text: string; rain: boolean }>; ask?: (p: string) => Promise<string>; seen?: (id: string, v: unknown) => void }
export interface RunResult { ok: boolean; node?: string; message?: string }
export const TYPES: Record<PortType, { label: string }>;
export const BLOCKS: Record<string, any>;
export const TRIGGERS: Record<string, { title: string }>;
export const DIRECTIONS: Record<'ltr' | 'ttb' | 'wrap', { title: string; out: string; in: string }>;
export const COMPARE_WORDS: Record<string, string>;
export const WHEN_FIELDS: { name: string; label: string; type: PortType; default: unknown }[];
export const WHEN_OP: { name: string; label: string; kind: string; choices: string[]; default: string };
export const VIEWS: string[];
export const WRAP_STEP: { x: number; y: number };
export function isBranch(kind: string): boolean;
export function normalizeDirection(d: unknown): 'ltr' | 'ttb' | 'wrap' | undefined;
export function readingOrder(g: Graph): Node[];
export function canConnect(from: string, to: string): { ok: boolean; why?: string };
export function portOf(kind: string, side: 'in' | 'out', name: string): any;
export function makeNode(kind: string, id: string, x?: number, y?: number): Node;
export function emptyGraph(): Graph;
export function nextId(g: Graph): string;
export function connect(g: Graph, from: { node: string; port: string }, to: { node: string; port: string }): { ok: boolean; why?: string };
export function removeNodes(g: Graph, ids: string[]): void;
export function duplicateNodes(g: Graph, ids: string[], dx?: number, dy?: number): string[];
export function serialize(g: Graph): string;
export function parseGraph(text: string): { graph: Graph; problems: string[] };
export function compile(g: Graph, opts?: { trace?: boolean }): { code: string; errors: Problem[]; order: Node[]; parent: Map<string, string | null> };
export function exportScript(g: Graph): string;
export function wrapForNode(code: string): string;
export function run(g: Graph, rt: Runtime, opts?: { limit?: number }): Promise<RunResult>;
export function makeHistory(limit?: number): { push(t: string): void; undo(now: string): string | undefined; redo(now: string): string | undefined; readonly canUndo: boolean; readonly canRedo: boolean };
export function searchBlocks(q: string): { kind: string; title: string; group: string }[];
export function graphFormatGuide(): string;
export function emptyWorkflow(): Workflow;
export function makeStep(kind: string, id: string): Step;
export function walkSteps(steps: Step[], fn: (s: Step, parents: Step[]) => void): void;
export function nextStepId(wf: Workflow): string;
export function availableOutputs(wf: Workflow, stepId: string): { node: string; port: string; label: string; type: PortType }[];
export function findStep(wf: Workflow, id: string): Step | undefined;
export function compileWorkflow(wf: Workflow, opts?: { trace?: boolean }): { code: string; errors: Problem[] };
export function runWorkflow(wf: Workflow, rt: Runtime, opts?: { limit?: number }): Promise<RunResult>;
export function graphToWorkflow(g: Graph, trigger?: Workflow['trigger']): { workflow?: Workflow; why?: string };
export function workflowToGraph(wf: Workflow): { graph?: Graph; why?: string; node?: string };
export function dailyDue(time: string, now?: Date): boolean;
export function serializeFile(g: Graph, wf: Workflow | undefined, view: string): string;
export function parseFile(text: string): { graph: Graph; workflow?: Workflow; view: 'graph' | 'flow' | 'text'; problems: string[] };
export function isDirection(d: unknown): boolean;
export function autoLayout(g: Graph, dir?: string, opts?: { width?: number }): Graph;
export function sampleFizzBuzz(): Graph;
export function sampleHello(): Graph;
export function sampleUmbrella(): Workflow;
