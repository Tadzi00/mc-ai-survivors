export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  /** Optional JSON schema hint. Providers use it if they can; otherwise "JSON mode" is used. */
  jsonSchema?: Record<string, unknown>;
  maxTokens: number;
  temperature: number;
  model: string;
}

export interface CompletionResult {
  text: string;
}

export interface LLMProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}
