import { GoogleGenAI } from "@google/genai";
import OpenAI, { ClientOptions } from 'openai';
import { getCachedConfig } from '../controllers/adminController';

// Type for a single provider's configuration
export interface ProviderDetail {
    apiKey?: string;
    apiKeyPool?: string;
    model?: string;
    baseURL?: string;
}

export interface AiProviderConfig {
    activeProvider: 'gemini' | 'openai' | 'deepseek';
    providers: {
        [key: string]: ProviderDetail;
        gemini: ProviderDetail;
        openai: ProviderDetail;
        deepseek: ProviderDetail;
    }
}

// Module-level index to implement a round-robin strategy for key selection.
// This ensures concurrent requests are distributed across the key pool.
// Initialize with a random value to prevent "thundering herd" on the first key
// when multiple server instances start up simultaneously.
let currentKeyIndex = Math.floor(Math.random() * 100);

const callGeminiWithRetry = async (apiKeyPoolOrKey: string, model: string, requestPayload: any): Promise<string | null> => {
    const keys = (apiKeyPoolOrKey || '').split(',').map(k => k.trim()).filter(Boolean);
    if (keys.length === 0) {
        throw new Error("No Gemini API keys were provided or configured.");
    }

    // --- ROUND-ROBIN & FAILOVER LOGIC ---
    // 1. Get the starting index for this specific request.
    const startIndex = currentKeyIndex;
    // 2. Immediately update the global index for the *next* request that comes in.
    currentKeyIndex = (currentKeyIndex + 1) % keys.length;

    let lastError: any = null;

    // 3. Loop through all keys, starting from our round-robin index, ensuring a full rotation for failover.
    for (let i = 0; i < keys.length; i++) {
        const keyIndex = (startIndex + i) % keys.length;
        const key = keys[keyIndex];

        try {
            const ai = new GoogleGenAI({ apiKey: key });
            const response = await ai.models.generateContent({
                model: model,
                ...requestPayload
            });
            console.log(`[aiService] Successfully used a Gemini key (last 4: ...${key.slice(-4)})`);
            return response.text || null;
        } catch (e: any) {
            const errorMessage = e.message || '';
            console.error(`[aiService] Gemini key ending in ...${key.slice(-4)} failed. Error: ${errorMessage}. Trying next key...`);
            lastError = e;

            // Check for recoverable errors. If not recoverable, break the loop.
            const isRecoverable = errorMessage.includes('API key') ||
                errorMessage.includes('quota') ||
                errorMessage.includes('rate limit') ||
                errorMessage.includes('overloaded') ||
                errorMessage.includes('UNAVAILABLE');

            if (!isRecoverable) {
                console.error(`[aiService] Unrecoverable error encountered. Stopping retry loop.`);
                break;
            }
        }
    }

    // If the loop completes without success, format and throw the final error.
    let finalErrorMessage = `All available Gemini API keys failed.`;
    if (lastError) {
        let parsedError;
        try {
            // The error message from the SDK is often a JSON string.
            parsedError = JSON.parse(lastError.message).error;
        } catch {
            parsedError = null;
        }

        // Check for specific error messages to provide a user-friendly response.
        if (parsedError && parsedError.message && (parsedError.message.toLowerCase().includes('quota') || parsedError.message.toLowerCase().includes('rate limit'))) {
            finalErrorMessage = 'SHARED_KEY_QUOTA_EXCEEDED';
        } else {
            finalErrorMessage += ` Last error: ${lastError.message}`;
        }
    }
    throw new Error(finalErrorMessage);
};


const callOpenAICompatible = async (providerConfig: ProviderDetail, systemInstruction: string, userPrompt: string, isJson: boolean, history: any[] = []) => {
    const { apiKey, model, baseURL } = providerConfig;
    if (!apiKey || !model) throw new Error("Missing API key or model for OpenAI-compatible provider.");

    const openAiConfig: ClientOptions = {
        apiKey,
        baseURL: baseURL || undefined, // Use baseURL from config, otherwise default (OpenAI)
    };

    // Add OpenRouter specific headers only if the baseURL matches
    if (baseURL?.includes('openrouter.ai')) {
        openAiConfig.defaultHeaders = {
            'HTTP-Referer': process.env.SITE_URL || 'https://cubegenai.com',
            'X-Title': 'CubeGen AI',
        };
    }

    const openai = new OpenAI(openAiConfig);

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: 'system', content: systemInstruction },
        ...history.map((h: any) => ({
            role: (h.role === 'model' ? 'assistant' : 'user') as 'assistant' | 'user',
            content: h.parts[0].text,
        })),
        { role: 'user', content: userPrompt }
    ];

    const completionConfig: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
        model,
        messages,
    };

    // Conditionally apply JSON mode only for models known to support it.
    if (isJson && (model.includes('gpt-4') || model.includes('gpt-3.5'))) {
        completionConfig.response_format = { type: 'json_object' };
    }

    const response = await openai.chat.completions.create(completionConfig);
    return response.choices[0].message.content || '';
};

const executeGeneration = async (
    systemInstruction: string,
    userPrompt: string,
    schema: any | null,
    history: any[],
    userProvidedKey?: string
): Promise<any> => {

    // If a key is passed directly, use it with Gemini and bypass all other logic.
    if (userProvidedKey) {
        console.log('[aiService] Using user-provided key.');
        const requestPayload = schema
            ? { contents: { parts: [{ text: userPrompt }] }, config: { systemInstruction, responseMimeType: "application/json", responseSchema: schema } }
            : { contents: history.length > 0 ? history : { parts: [{ text: userPrompt }] }, config: { systemInstruction } };

        const result = await callGeminiWithRetry(userProvidedKey, 'gemini-2.5-flash', requestPayload);
        if (schema && result) return JSON.parse(result);
        return result;
    }

    // Otherwise, use the centrally configured provider.
    const config = await getCachedConfig();

    let aiConfig: AiProviderConfig;
    try {
        // The config value is a JSON string from the database, so it must be parsed.
        aiConfig = JSON.parse(config.ai_provider_config || '{}');
    } catch (e) {
        console.error("[aiService] Failed to parse ai_provider_config JSON:", config.ai_provider_config);
        throw new Error('AI provider configuration is malformed. Please check the admin panel.');
    }

    if (!aiConfig.providers || !aiConfig.activeProvider) {
        throw new Error('AI provider configuration is missing required fields.');
    }
    const { activeProvider, providers } = aiConfig;
    const providerConfig = providers[activeProvider];

    if (!providerConfig || (!providerConfig.apiKey && !providerConfig.apiKeyPool) || !providerConfig.model) {
        throw new Error(`AI provider '${activeProvider}' is not configured. Please set an API key/pool and model name in the admin panel.`);
    }

    let resultString: string | null = null;

    if (activeProvider === 'gemini') {
        const keySource = providerConfig.apiKeyPool || providerConfig.apiKey;
        if (!keySource) throw new Error("Gemini provider is active but no API key or key pool is configured.");

        const requestPayload = schema
            ? { contents: { parts: [{ text: userPrompt }] }, config: { systemInstruction, responseMimeType: "application/json", responseSchema: schema } }
            : { contents: history.length > 0 ? history : { parts: [{ text: userPrompt }] }, config: { systemInstruction } };

        resultString = await callGeminiWithRetry(keySource, providerConfig.model, requestPayload);
    } else {
        const openAiSystemInstruction = schema
            ? `${systemInstruction}\n\nYou MUST respond with a valid JSON object that strictly adheres to the provided schema. Do not include any explanatory text, markdown formatting, or any characters outside of the JSON object itself.`
            : systemInstruction;

        resultString = await callOpenAICompatible(providerConfig, openAiSystemInstruction, userPrompt, !!schema, history.slice(0, -1));
    }

    if (!resultString) {
        throw new Error("AI model returned an empty response.");
    }

    if (schema) {
        try {
            const cleanedJson = resultString.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(cleanedJson);
        } catch (e) {
            console.error("Failed to parse JSON from AI response:", resultString);
            throw new Error("The AI model returned an invalid JSON format.");
        }
    }

    return resultString;
}


export const generateJsonFromPrompt = async (systemInstruction: string, userPrompt: string, schema: any, userProvidedKey?: string): Promise<any> => {
    return executeGeneration(systemInstruction, userPrompt, schema, [], userProvidedKey);
};

export const generateTextFromPrompt = async (systemInstruction: string, userPrompt: string, userProvidedKey?: string): Promise<string> => {
    return executeGeneration(systemInstruction, userPrompt, null, [], userProvidedKey);
};

export const generateChatResponse = async (history: any[], systemInstruction: string, userProvidedKey?: string): Promise<string> => {
    const lastMessage = history[history.length - 1];
    if (!lastMessage || lastMessage.role !== 'user') {
        throw new Error("Chat history must end with a user message.");
    }
    const userPrompt = lastMessage.parts[0].text;
    return executeGeneration(systemInstruction, userPrompt, null, history, userProvidedKey);
};
