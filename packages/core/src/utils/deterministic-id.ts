import { v5 as uuidv5 } from "uuid";

const ULTRAMEMORY_NAMESPACE = "7f3e8a2b-4c5d-4e6f-8a9b-1c2d3e4f5a6b";

export function deterministicId(scope: string, text: string): string {
  const input = `${scope}\0${text}`;
  return uuidv5(input, ULTRAMEMORY_NAMESPACE);
}
