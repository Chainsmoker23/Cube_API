import * as express from 'express';
import { GoogleGenAI } from "@google/genai";
import { getCachedConfig } from './adminController';

const handleError = (res: express.Response, error: unknown, defaultMessage: string = 'An unexpected error occurred.') => {
    const errorMessage = error instanceof Error ? error.message : defaultMessage;
    console.error(`[Backend Error] ${errorMessage}`);
    if (errorMessage.includes("API key")) {
        return res.status(400).json({ error: errorMessage });
    }
    if (errorMessage.includes("quota")) {
        return res.status(429).json({ error: 'SHARED_KEY_QUOTA_EXCEEDED' });
    }
    return res.status(500).json({ error: errorMessage });
};

export const handleChatWithAssistant = async (req: express.Request, res: express.Response) => {
    try {
        const config = await getCachedConfig();
        const apiKey = config.gemini_api_key;
        if (!apiKey) {
            return res.status(500).json({ error: 'Assistant is currently unavailable (API key not configured).' });
        }
        
        const { history } = req.body;
        if (!history || !Array.isArray(history)) {
            return res.status(400).json({ error: 'Invalid chat history provided.' });
        }

        const systemInstruction = `You are Archie, an expert AI assistant for CubeGen AI, a tool that generates architecture diagrams from text. Your primary goal is to help users, especially new ones, get the most out of the app. Your responses MUST be concise and friendly.

**Core Knowledge about CubeGen AI:**

*   **What it is:** A tool that instantly generates visual software architecture diagrams from a text description (a "prompt").
*   **Mission:** CubeGen AI is a non-profit project founded by Divesh Sarkar, with the goal of making professional design tools accessible to everyone.
*   **Modelers:** The app has two main modes:
    *   **General Architecture:** For cloud systems (AWS, GCP, Azure), microservices, etc.
    *   **Neural Network Modeler:** For visualizing neural network structures.
*   **Key Features:**
    *   **Playground Mode:** After generating a diagram, users can enter a "Playground" to manually move, edit, and refine every component.
    *   **Exporting:** Diagrams can be exported as PNG, HTML, or JSON.
    *   **AI Explanation:** Users can ask the AI to explain a generated diagram.
*   **Plans & Pricing:**
    *   **Free/Hobbyist:** Have limited monthly generations.
    *   **Pro/Business:** Offer unlimited generations by allowing users to generate and use a personal API key in the app's settings. This bypasses shared limits.

**Your Task:**

1.  **Be Brief & Friendly:** Keep conversational text to a maximum of two sentences. Be welcoming.
2.  **Guide New Users:** If a user seems new or asks a basic question, briefly explain a relevant feature. For example, if they ask for an idea, suggest a prompt and mention they can edit it in the Playground.
3.  **Suggest Prompts:** When asked for a prompt idea, provide a creative, ready-to-use prompt inside a markdown code block labeled 'prompt'.
4.  **Answer Questions:** Use the "Core Knowledge" above to answer questions. If asked who owns the app, state that "Divesh Sarkar is the founder of CubeGen AI."
5.  **Initial Greeting:** Your very first message MUST be: "Hi! I'm Archie, your AI assistant. How can I help you design something today? You can ask me for a prompt idea!"`;
        
        const ai = new GoogleGenAI({ apiKey });
        
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: history,
            config: {
                systemInstruction: systemInstruction
            }
        });

        const responseText = response.text;

        if (!responseText) {
             return res.json({ response: "I'm sorry, I couldn't generate a response. Please try again." });
        }

        res.json({ response: responseText });
    } catch (e) {
        handleError(res, e, 'Failed to get a response from the assistant.');
    }
};