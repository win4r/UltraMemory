export const BUILTIN_ALIASES: Record<string, string> = {
  // Programming languages
  'ts': 'typescript', 'typescript': 'typescript',
  'js': 'javascript', 'javascript': 'javascript',
  'py': 'python', 'python': 'python',
  'rb': 'ruby', 'ruby': 'ruby',
  'rs': 'rust', 'rust': 'rust',
  'go': 'golang', 'golang': 'golang',
  'cs': 'csharp', 'c#': 'csharp',

  // Frameworks
  'react.js': 'react', 'reactjs': 'react', 'react': 'react',
  'vue.js': 'vue', 'vuejs': 'vue', 'vue': 'vue',
  'next.js': 'nextjs', 'next': 'nextjs', 'nextjs': 'nextjs',
  'node.js': 'nodejs', 'node': 'nodejs', 'nodejs': 'nodejs',
  'express.js': 'express', 'express': 'express',
  'angular.js': 'angular', 'angularjs': 'angular', 'angular': 'angular',
  'svelte': 'svelte', 'sveltekit': 'sveltekit',

  // Infrastructure
  'k8s': 'kubernetes', 'kubernetes': 'kubernetes',
  'pg': 'postgresql', 'postgres': 'postgresql', 'postgresql': 'postgresql',
  'mongo': 'mongodb', 'mongodb': 'mongodb',
  'redis': 'redis',
  'terraform': 'terraform',
  'gcp': 'google cloud platform',
  'aws': 'amazon web services',
  'docker': 'docker',

  // AI/ML
  'gpt': 'openai gpt', 'chatgpt': 'openai gpt',
  'tensorflow': 'tensorflow',
  'pt': 'pytorch', 'pytorch': 'pytorch',
  'hf': 'hugging face', 'huggingface': 'hugging face',
  'llm': 'large language model',
  'rag': 'retrieval augmented generation',
  'lancedb': 'lancedb',
};

export class EntityResolver {
  private aliases: Map<string, string>;

  constructor(
    builtinAliases: Record<string, string>,
    userAliases?: Record<string, string>,
  ) {
    this.aliases = new Map();
    for (const [k, v] of Object.entries(builtinAliases)) {
      this.aliases.set(k.toLowerCase(), v);
    }
    if (userAliases) {
      for (const [k, v] of Object.entries(userAliases)) {
        this.aliases.set(k.toLowerCase(), v);
      }
    }
  }

  resolve(topic: string): string {
    const lower = topic.toLowerCase().trim();
    return this.aliases.get(lower) ?? lower;
  }
}
