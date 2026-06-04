import { openai } from "@ai-sdk/openai";

// The one place the model is configured.
//   - cheaper for a workshop → a "-mini" / "-nano" variant (e.g. "gpt-5-mini")
//   - this default            → "gpt-5.5"
//
// The provider reads OPENAI_API_KEY from the environment at request time
// (the server loads it from .dev.vars on startup).
export const model = openai("gpt-5.5");
