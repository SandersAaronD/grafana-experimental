/**
 * OpenAI API client.
 *
 * This module contains functions used to make requests to the OpenAI API via
 * the Grafana LLM app plugin. That plugin must be installed, enabled and configured
 * in order for these functions to work.
 *
 * The {@link enabled} function can be used to check if the plugin is enabled and configured.
 */

import { isLiveChannelMessageEvent, LiveChannelAddress, LiveChannelMessageEvent, LiveChannelScope } from "@grafana/data";
import { getBackendSrv, getGrafanaLiveSrv, logDebug } from "@grafana/runtime";

import { Observable } from "rxjs";
import { filter, map, takeWhile } from "rxjs/operators";

const LLM_PLUGIN_ID = 'grafana-llm-app';
const LLM_PLUGIN_ROUTE = `/api/plugins/${LLM_PLUGIN_ID}`;

/**
 * The role of a message's author.
 */
export type Role = 'system' | 'user' | 'assistant' | 'function';

/**
 * A message in a conversation.
 */
export interface Message {
  /**
   * The role of the message's author.
   */
  role: Role;

  /**
   * The contents of the message. content is required for all messages, and may be null for assistant messages with function calls.
   */
  content: string;

  /**
   * The name of the author of this message.
   *
   * This is required if role is 'function', and it should be the name of the function whose response is in the content.
   *
   * May contain a-z, A-Z, 0-9, and underscores, with a maximum length of 64 characters.
   */
  name?: string;

  /**
   * The name and arguments of a function that should be called, as generated by the model.
   */
  function_call?: Object;
}

/**
 * A function the model may generate JSON inputs for.
 */
export interface Function {
  /**
   * The name of the function to be called.
   *
   * Must be a-z, A-Z, 0-9, or contain underscores and dashes, with a maximum length of 64.
   */
  name: string;
  /**
   * A description of what the function does, used by the model to choose when and how to call the function.
   */
  description?: string;
  /*
   * The parameters the functions accepts, described as a JSON Schema object. See the OpenAI guide for examples, and the JSON Schema reference for documentation about the format.
   *
   * To describe a function that accepts no parameters, provide the value {"type": "object", "properties": {}}.
   */
  parameters: Object;
}

export interface ChatCompletionsRequest {
  /**
   * ID of the model to use.
   *
   * See the model endpoint compatibility table for details on which models work with the Chat Completions API.
   */
  model: string;
  /**
   * A list of messages comprising the conversation so far.
   */
  messages: Message[];
  /**
   * A list of functions the model may generate JSON inputs for.
   */
  functions?: Function[];
  /**
   * Controls how the model responds to function calls.
   *
   * "none" means the model does not call a function, and responds to the end-user.
   * "auto" means the model can pick between an end-user or calling a function.
   * Specifying a particular function via {"name": "my_function"} forces the model to call that function.
   *
   * "none" is the default when no functions are present. "auto" is the default if functions are present.
   */
  function_call?: 'none' | 'auto' | { name: string };
  /**
   * What sampling temperature to use, between 0 and 2.
   * Higher values like 0.8 will make the output more random, while lower values like 0.2 will make it more focused and deterministic.
   *
   * We generally recommend altering this or top_p but not both.
   */
  temperature?: number;
  /**
   * An alternative to sampling with temperature, called nucleus sampling, where the model considers the results of the tokens with top_p probability mass.
   * So 0.1 means only the tokens comprising the top 10% probability mass are considered.
   *
   * We generally recommend altering this or temperature but not both.
   */
  top_p?: number;
  /**
   * How many chat completion choices to generate for each input message.
   */
  n?: number;
  /**
   * Up to 4 sequences where the API will stop generating further tokens.
   */
  stop?: string | string[];
  /**
   * The maximum number of tokens to generate in the chat completion.
   *
   * The total length of input tokens and generated tokens is limited by the model's context length. Example Python code for counting tokens.
   */
  max_tokens?: number;
  /**
   * Number between -2.0 and 2.0.
   *
   * Positive values penalize new tokens based on whether they appear in the text so far, increasing the model's likelihood to talk about new topics.
   */
  presence_penalty?: number;
  /**
   * Number between -2.0 and 2.0.
   *
   * Positive values penalize new tokens based on their existing frequency in the text so far, decreasing the model's likelihood to repeat the same line verbatim.
   */
  frequency_penalty?: number;
  /**
   * Modify the likelihood of specified tokens appearing in the completion.
   *
   * Accepts a json object that maps tokens (specified by their token ID in the tokenizer) to an associated bias value from -100 to 100.
   * Mathematically, the bias is added to the logits generated by the model prior to sampling. The exact effect will vary per model,
   * but values between -1 and 1 should decrease or increase likelihood of selection; values like -100 or 100 should result in a ban
   * or exclusive selection of the relevant token.
   */
  logit_bias?: { [key: string]: number };
  /**
   * A unique identifier representing your end-user, which can help OpenAI to monitor and detect abuse.
   */
  user?: string;
}

interface Choice {
  message: Message;
}

interface ChatCompletionsResponse<T = Choice> {
  choices: T[];
}

interface ContentMessage {
  content: string;
}

interface RoleMessage {
  role: string;
}

interface DoneMessage {
  done: boolean;
}

type ChatCompletionsDelta = ContentMessage | RoleMessage | DoneMessage;

interface ChatCompletionsChunk {
  delta: ChatCompletionsDelta;
}

const isContentMessage = (message: any): message is ContentMessage => {
  return message.content !== undefined;
}

const isDoneMessage = (message: any): message is DoneMessage => {
  return message.done !== undefined;
}

/**
 * Make a request to OpenAI's chat-completions API via the Grafana LLM plugin proxy.
 */
export async function chatCompletions(request: ChatCompletionsRequest): Promise<string> {
  const response = await getBackendSrv().post<ChatCompletionsResponse>('/api/plugins/grafana-llm-app/resources/openai/v1/chat/completions', request, {
    headers: { 'Content-Type': 'application/json' }
  });
  return response.choices[0].message.content;
}

/**
 * Make a streaming request to OpenAI's chat-completions API via the Grafana LLM plugin proxy.
 *
 * A stream of tokens will be returned as an `Observable<string>`. Use rxjs' `scan` if you want
 * to produce a new stream containing the concatenated tokens so far.
 *
 * @example <caption>Example of accumulating tokens in a stream.</caption>
 * const stream = streamChatCompletions({ model: 'gpt-3.5-turbo', messages: [
 *   { role: 'system', content: 'You are a great bot.' },
 *   { role: 'user', content: 'Hello, bot.' },
 * ]}).pipe(scan((acc, delta) => acc + delta, ''));
 */
export function streamChatCompletions(request: ChatCompletionsRequest): Observable<string> {
  const channel: LiveChannelAddress = {
    scope: LiveChannelScope.Plugin,
    namespace: LLM_PLUGIN_ID,
    path: `/openai/v1/chat/completions`,
    data: request,
  };
  const messages = getGrafanaLiveSrv()
    .getStream(channel)
    .pipe(filter((event) => isLiveChannelMessageEvent(event))) as Observable<LiveChannelMessageEvent<ChatCompletionsResponse<ChatCompletionsChunk>>>
  return messages.pipe(
    takeWhile((event) => !isDoneMessage(event.message.choices[0].delta)),
    map((event) => event.message.choices[0].delta),
    filter((delta) => isContentMessage(delta)),
    map((delta) => (delta as ContentMessage).content),
  );
}

let loggedWarning = false;

/**
 * Check if the OpenAI API is enabled via the LLM plugin.
 */
export const enabled = async () => {
  try {
    const settings = await getBackendSrv().get(`${LLM_PLUGIN_ROUTE}/settings`, undefined, undefined, {
      showSuccessAlert: false, showErrorAlert: false,
    });
    return settings.enabled && (settings?.secureJsonFields?.openAIKey ?? false);
  } catch (e) {
    if (!loggedWarning) {
      logDebug(String(e));
      logDebug('Failed to check if OpenAI is enabled. This is expected if the Grafana LLM plugin is not installed, and the above error can be ignored.');
      loggedWarning = true;
    }
    return false;
  }
}
