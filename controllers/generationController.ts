import * as express from 'express';
// FIX: Updated to use modern GoogleGenAI SDK instead of deprecated GoogleGenerativeAI
import { GoogleGenAI, Type } from "@google/genai";
import { authenticateUser, checkAndIncrementGenerationCount } from '../userUtils';
import { supabaseAdmin } from '../supabaseClient';
import { User } from '@supabase/supabase-js';
import crypto from 'crypto';

// --- SCHEMAS & PROMPTS ---

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: "A concise title for the architecture diagram." },
    architectureType: { type: Type.STRING, description: "The main architecture category (e.g., AWS, GCP, Azure, Microservices)." },
    nodes: {
      type: Type.ARRAY,
      description: "A list of all components in the architecture.",
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING, description: "A unique, kebab-case identifier for the node (e.g., 'web-server-1')." },
          label: { type: Type.STRING, description: "The human-readable name of the component (e.g., 'EC2 Instance')." },
          type: { type: Type.STRING, description: "The type of component for icon mapping. Use one of the predefined types like 'aws-ec2', 'user', 'database', 'neuron', 'layer-label', 'group-label'." },
          description: { type: Type.STRING, description: "A brief, one-sentence description of the node's purpose. For 'neuron', 'layer-label', or 'group-label' types, this can be an empty string." },
          shape: { type: Type.STRING, description: "Optional. The visual shape of the node. Can be 'rectangle', 'ellipse', or 'diamond'. Defaults to 'rectangle'."},
          x: { type: Type.NUMBER, description: "The initial horizontal position of the node's center on a 1200x800 canvas." },
          y: { type: Type.NUMBER, description: "The initial vertical position of the node's center." },
          width: { type: Type.NUMBER, description: "The initial width of the node. For 'neuron' type, this should be small (e.g., 30). For 'layer-label' this should be wide enough for the text." },
          height: { type: Type.NUMBER, description: "The initial height of the node. For 'neuron' type, this should be small (e.g., 30). For 'layer-label' this can be small (e.g., 20)." },
          color: { type: Type.STRING, description: "Optional hex color code for the node. For 'neuron' type, use '#2B2B2B' for input/output layers and '#D1D5DB' for hidden layers." },
        },
        required: ["id", "label", "type", "description", "x", "y", "width", "height"],
      },
    },
    links: {
      type: Type.ARRAY,
      description: "A list of connections between the components.",
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING, description: "A unique, kebab-case identifier for the link (e.g., 'user-to-lb-1')." },
          source: { type: Type.STRING, description: "The 'id' of the source node." },
          target: { type: Type.STRING, description: "The 'id' of the target node." },
          label: { type: Type.STRING, description: "Optional label for the connection to indicate data flow (e.g., 'HTTP Request')." },
          style: { type: Type.STRING, description: "The line style. Can be 'solid', 'dotted', 'dashed', or 'double'." },
          thickness: { type: Type.STRING, description: "The thickness of the link. Can be 'thin', 'medium', 'thick'." },
          bidirectional: { type: Type.BOOLEAN, description: "If true, the link will have arrowheads on both ends." },
        },
        required: ["id", "source", "target"],
      },
    },
    containers: {
      type: Type.ARRAY,
      description: "A list of bounding boxes for logical groupings like tiers, regions, or availability zones.",
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING, description: "A unique, kebab-case identifier for the container." },
          label: { type: Type.STRING, description: "The name of the grouping (e.g., 'API Tier')." },
          type: { type: Type.STRING, description: "The type of container: 'region', 'availability-zone', or 'tier'." },
          childNodeIds: { type: Type.ARRAY, items: { type: Type.STRING }, description: "An array of node 'id's that belong inside this container." },
          x: { type: Type.NUMBER, description: "The top-left horizontal position of the container." },
          y: { type: Type.NUMBER, description: "The top-left vertical position of the container." },
          width: { type: Type.NUMBER, description: "The width of the container." },
          height: { type: Type.NUMBER, description: "The height of the container." },
        },
        required: ["id", "label", "type", "childNodeIds", "x", "y", "width", "height"],
      },
    },
  },
  required: ["title", "architectureType", "nodes", "links"],
};

const neuralNetworkSchema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: "A concise title for the neural network diagram (e.g., 'Simple Feedforward Network')." },
    nodes: {
      type: Type.ARRAY,
      description: "A list of all neurons and layer labels.",
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING, description: "A unique identifier for the node (e.g., 'input-1', 'hidden-1-2')." },
          label: { type: Type.STRING, description: "The name of the node. For neurons, this can be the ID. For labels, it describes the layer (e.g., 'Input Layer')." },
          type: { type: Type.STRING, description: "The type of node. Must be either 'neuron' or 'layer-label'." },
          layer: { type: Type.NUMBER, description: "The layer number this node belongs to (e.g., 0 for input, 1 for first hidden, etc.)." },
        },
        required: ["id", "label", "type", "layer"],
      },
    },
    links: {
      type: Type.ARRAY,
      description: "A list of connections between the neurons, typically connecting all neurons in one layer to all neurons in the next.",
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING, description: "A unique identifier for the link." },
          source: { type: Type.STRING, description: "The 'id' of the source neuron." },
          target: { type: Type.STRING, description: "The 'id' of the target neuron." },
        },
        required: ["id", "source", "target"],
      },
    },
  },
  required: ["title", "nodes", "links"],
};

const systemPrompt = `You are an expert system architect. Your task is to generate a JSON representation of a software architecture diagram based on a user's prompt. The JSON must strictly adhere to the provided schema.

**Layout Philosophy: The "Swimlane" Principle**
For any diagram with logical tiers (e.g., Presentation, Application, Data), you MUST adopt a strict, columnar (swimlane) layout. This is your highest priority for achieving a professional look.
1.  **Tier Containers as Swimlanes:** Each logical tier MUST be represented by a \`container\` of type 'tier'. These containers should be arranged side-by-side (horizontally) and should ideally span the full vertical height of the main diagram area to create distinct visual columns.
2.  **Strict Data Flow:** The primary data flow MUST proceed from left to right across these swimlanes. A user should be able to understand the sequence of operations just by looking at the layout.
3.  **Alignment is Key:** Within each tier (swimlane), align the nodes vertically. This creates a clean, organized, grid-like structure. Strive for consistent spacing between nodes.
4.  **Clean Link Routing:** Route links as cleanly as possible. Minimize crossovers. Links should primarily flow from a node in one tier to a node in the next tier to the right.

**Other Key Instructions:**
1.  **Icon Mapping:** Choose the most appropriate 'type' for each node from the predefined list in the schema. This is crucial for correct icon rendering.
2.  **IDs:** All 'id' fields for nodes, links, and containers must be unique and in kebab-case.
3.  **Connections:** Ensure all 'source' and 'target' fields in the 'links' array correspond to valid node 'id's.
4.  **Labels (Crucial):** BE EXTREMELY CONSERVATIVE WITH LABELS. The user wants clean diagrams.
    - DO NOT use link labels for common interactions like 'API Call' or 'HTTP Request'. The connection itself implies this.
    - DO NOT use floating text labels (\`layer-label\` or \`group-label\`) to label a tier if it is already inside a labeled container. The container's label is sufficient.
    - For a simple architecture (e.g., a 3-tier app), generate a MAXIMUM of 3-4 essential labels.
    - For complex architectures, generate a MAXIMUM of 6-8 labels.
    - Only add a label if it clarifies a major concept that is impossible to understand from the component icons and container labels alone.
5.  **Neural Networks:** If the prompt is for a neural network, use the 'neuron' and 'layer-label' types. Calculate layer numbers starting from 0 for the input layer. Neurons should be small and circular. Lay out neurons in distinct vertical layers.
6.  **Node Sizing:** Ensure the 'width' and 'height' for each node are sufficiently large to contain the 'label' text comfortably without truncation. For longer labels like "Smart Contract Interaction," use a wider 'width' (e.g., 180) and a taller 'height' (e.g., 90) to allow for text wrapping.
`;


// --- HELPER FUNCTIONS ---

const getApiKeyForRequest = async (req: express.Request, user: User | null): Promise<string | null> => {
    // Priority 1: User-provided key in the request body (for temporary modal overrides)
    if (req.body.userApiKey) {
        return req.body.userApiKey;
    }
    // Priority 2: User's own key stored securely in their app_metadata
    if (user && user.app_metadata?.personal_api_key) {
        return user.app_metadata.personal_api_key;
    }
    // Priority 3: Shared key from environment variables (fallback)
    return process.env.GEMINI_API_KEY || null;
};

const getGeminiResponse = async (apiKey: string, promptPayload: any, schema?: any) => {
    try {
        const ai = new GoogleGenAI({ apiKey });
        const model = schema ? 'gemini-2.5-flash' : 'gemini-2.5-pro';

        const contents = promptPayload.contents || promptPayload;
        const systemInstruction = promptPayload.systemInstruction;
        
        const config: any = schema ? {
            responseMimeType: "application/json",
            responseSchema: schema,
        } : {};

        if (systemInstruction) {
            config.systemInstruction = systemInstruction;
        }

        const response = await ai.models.generateContent({
            model: model,
            contents: contents,
            config: Object.keys(config).length > 0 ? config : undefined
        });

        const text = response.text;
        
        if (schema) {
             if (!text) {
                throw new Error("Gemini API returned an empty response, but a JSON object was expected.");
            }
            const cleanedJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(cleanedJson);
        }
        return text || "";
    } catch (e: any) {
        console.error("Gemini API Error:", e.message, e.stack);
        // Provide a more specific error for API key issues
        if (e.message.includes('API key not valid')) {
            throw new Error("The provided API key is invalid. Please check your key and try again.");
        }
        if (e.message.includes('quota')) {
            throw new Error("The API key has exceeded its quota. Please check your billing or try another key.");
        }
        throw new Error(`Gemini API Error: ${e.message}`);
    }
};

const handleError = (res: express.Response, error: unknown, defaultMessage: string = 'An unexpected error occurred.') => {
    const errorMessage = error instanceof Error ? error.message : defaultMessage;
    console.error(`[Backend Error] ${errorMessage}`);
    if (errorMessage.includes("API key")) {
        return res.status(400).json({ error: errorMessage });
    }
    if (errorMessage.includes("quota")) {
        return res.status(429).json({ error: 'SHARED_KEY_QUOTA_EXCEEDED' });
    }
    if (errorMessage.includes("GENERATION_LIMIT_EXCEEDED")) {
        return res.status(429).json({ error: 'GENERATION_LIMIT_EXCEEDED' });
    }
    return res.status(500).json({ error: errorMessage });
};


// --- CONTROLLER FUNCTIONS ---

export const handleGenerateDiagram = async (req: express.Request, res: express.Response) => {
    const user = await authenticateUser(req);
    if (!user) {
        return res.status(401).json({ error: 'Unauthorized: Invalid authentication token.' });
    }

    const { allowed, error: limitError } = await checkAndIncrementGenerationCount(user);
    if (!allowed) {
        return handleError(res, new Error(limitError));
    }

    try {
        const apiKey = await getApiKeyForRequest(req, user);
        if (!apiKey) {
            return res.status(400).json({ error: 'API key is missing.' });
        }
        const { prompt } = req.body;
        const fullPrompt = {
            parts: [
                { text: systemPrompt },
                { text: `Generate the JSON for the following prompt: "${prompt}"` }
            ]
        };
        const data = await getGeminiResponse(apiKey, fullPrompt, responseSchema);
        res.json(data);
    } catch (e) {
        handleError(res, e);
    }
};

export const handleGenerateNeuralNetwork = async (req: express.Request, res: express.Response) => {
    const user = await authenticateUser(req);
    if (!user) {
        return res.status(401).json({ error: 'Unauthorized: Invalid authentication token.' });
    }

    const { allowed, error: limitError } = await checkAndIncrementGenerationCount(user);
    if (!allowed) {
        return handleError(res, new Error(limitError));
    }

    try {
        const apiKey = await getApiKeyForRequest(req, user);
        if (!apiKey) {
            return res.status(400).json({ error: 'API key is missing.' });
        }
        const { prompt } = req.body;
         const fullPrompt = {
            parts: [
                { text: systemPrompt },
                { text: `Generate the JSON for the following neural network prompt: "${prompt}"` }
            ]
        };
        const data = await getGeminiResponse(apiKey, fullPrompt, neuralNetworkSchema);
        res.json(data);
    } catch (e) {
        handleError(res, e);
    }
};

export const handleExplainArchitecture = async (req: express.Request, res: express.Response) => {
    const user = await authenticateUser(req);
    if (!user) {
        // Allow explanation even for non-logged-in users if a key is provided
        if (!req.body.userApiKey && !process.env.GEMINI_API_KEY) {
            return res.status(401).json({ error: 'Unauthorized: Authentication required.' });
        }
    }

    try {
        const apiKey = await getApiKeyForRequest(req, user);
        if (!apiKey) {
            return res.status(400).json({ error: 'API key is missing.' });
        }
        const { diagramData } = req.body;
        const prompt = `Based on the following JSON data representing an architecture diagram, provide a concise, markdown-formatted explanation of what the system does, its key components, and how they interact. JSON: ${JSON.stringify(diagramData)}`;
        const explanation = await getGeminiResponse(apiKey, prompt);
        res.json({ explanation });
    } catch (e) {
        handleError(res, e);
    }
};

// --- API KEY MANAGEMENT CONTROLLERS ---

export const handleGetApiKey = async (req: express.Request, res: express.Response) => {
    const user = await authenticateUser(req);
    if (!user) {
        return res.status(401).json({ error: 'Unauthorized.' });
    }
    try {
        // The user object from authenticateUser contains app_metadata
        const apiKey = user.app_metadata?.personal_api_key || null;
        res.json({ apiKey });
    } catch (e) {
        handleError(res, e, 'Failed to retrieve API key.');
    }
};

export const handleGenerateApiKey = async (req: express.Request, res: express.Response) => {
    const user = await authenticateUser(req);
    if (!user) {
        return res.status(401).json({ error: 'Unauthorized.' });
    }

    const plan = user.user_metadata?.plan || 'free';
    if (!['pro', 'business'].includes(plan)) {
        return res.status(403).json({ error: 'Forbidden: API key generation is a premium feature.' });
    }

    try {
        const newKey = `cg_sk_${crypto.randomBytes(20).toString('hex')}`;
        
        const { data, error } = await supabaseAdmin.auth.admin.updateUserById(
            user.id,
            { app_metadata: { ...user.app_metadata, personal_api_key: newKey } }
        );

        if (error || !data.user) {
            throw error || new Error('Failed to update user with new key.');
        }

        res.status(201).json({ apiKey: newKey });
    } catch (e) {
        handleError(res, e, 'Failed to generate API key.');
    }
};

export const handleRevokeApiKey = async (req: express.Request, res: express.Response) => {
    const user = await authenticateUser(req);
    if (!user) {
        return res.status(401).json({ error: 'Unauthorized.' });
    }

    try {
        const { error } = await supabaseAdmin.auth.admin.updateUserById(
            user.id,
            { app_metadata: { ...user.app_metadata, personal_api_key: null } }
        );
        
        if (error) throw error;

        res.status(204).send(); // No content
    } catch (e) {
        handleError(res, e, 'Failed to revoke API key.');
    }
};