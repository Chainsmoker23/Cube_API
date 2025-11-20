import * as express from 'express';
import * as aiService from '../services/aiService';
import { responseSchema as diagramResponseSchema, systemPrompt as diagramSystemPrompt } from './generationController'; // Re-use the schema and prompt

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
        
        // The user's personal API key (used for auth) is NOT passed to the AI service.
        // This ensures the public API always uses the app's centrally managed, rotating key pool.
        const data = await aiService.generateJsonFromPrompt(
            diagramSystemPrompt,
            `Generate the JSON for the following prompt: "${prompt}"`,
            diagramResponseSchema
        );
        
        res.json({ diagram: data });
    } catch (e: any) {
        console.error(`[Public API Error] ${e.message}`);
        res.status(500).json({ error: e.message || 'An internal server error occurred.' });
    }
};
