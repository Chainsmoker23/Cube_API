import * as express from 'express';
import { GoogleGenAI, Type } from "@google/genai";
import { getApiKeyForRequest } from '../services/apiKeyService';
import { responseSchema as diagramResponseSchema, systemPrompt as diagramSystemPrompt } from './generationController'; // Re-use the schema and prompt

const getGeminiResponse = async (apiKey: string, promptPayload: any, schema: any) => {
    try {
        const ai = new GoogleGenAI({ apiKey });
        const model = 'gemini-2.5-flash';
        
        const response = await ai.models.generateContent({
            model: model,
            contents: { parts: promptPayload.parts },
            config: {
                responseMimeType: "application/json",
                responseSchema: schema,
            }
        });
        
        // Add system instruction if provided
        if (promptPayload.systemInstruction) {
            (response as any).config.systemInstruction = promptPayload.systemInstruction;
        }

        const text = response.text;
        
        if (!text) {
            throw new Error("Gemini API returned an empty response, but a JSON object was expected.");
        }
        const cleanedJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(cleanedJson);

    } catch (e: any) {
        console.error("Gemini API Error (Public Endpoint):", e.message, e.stack);
        if (e.message.includes('API key not valid')) {
            throw new Error("The application's shared API key is invalid. Please contact support.");
        }
        if (e.message.includes('quota')) {
            throw new Error("The application's shared API key has exceeded its quota. Please contact support.");
        }
        throw new Error(`Gemini API Error: ${e.message}`);
    }
};

export const handlePublicGenerateDiagram = async (req: express.Request, res: express.Response) => {
    // The user is attached by the apiKeyAuth middleware
    if (!req.user) {
        // This should theoretically not be reached if middleware is applied correctly
        return res.status(401).json({ error: 'Unauthorized.' });
    }

    try {
        const { prompt } = req.body;
        if (!prompt || typeof prompt !== 'string') {
            return res.status(400).json({ error: 'Missing or invalid "prompt" in request body.' });
        }
        
        // Pro users authenticated via API key get to use the shared app key without limit checks.
        // `getApiKeyForRequest` handles this logic perfectly.
        const apiKey = await getApiKeyForRequest(req.user, undefined, { checkLimits: false });

        const fullPrompt = {
            parts: [
                { text: diagramSystemPrompt },
                { text: `Generate the JSON for the following prompt: "${prompt}"` }
            ]
        };

        const data = await getGeminiResponse(apiKey, fullPrompt, diagramResponseSchema);
        
        res.json({ diagram: data });
    } catch (e: any) {
        console.error(`[Public API Error] ${e.message}`);
        res.status(500).json({ error: e.message || 'An internal server error occurred.' });
    }
};
