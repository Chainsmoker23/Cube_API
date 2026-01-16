import * as express from 'express';
import { Type } from "@google/genai";
import { authenticateUser, consumeGenerationCredit, canUserGenerate } from '../userUtils';
import * as aiService from '../services/aiService';

// --- SCHEMAS & PROMPTS ---

export const responseSchema = {
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
          type: { type: Type.STRING, description: "The type of component for icon mapping. Use one of the predefined types like 'aws-ec2', 'user', 'database', etc. CRITICAL: Do NOT use the 'neuron' type for general architecture diagrams." },
          description: { type: Type.STRING, description: "A brief, one-sentence description of the node's purpose. Can be an empty string for purely visual elements." },
          shape: { type: Type.STRING, description: "Optional. The visual shape of the node. Can be 'rectangle', 'ellipse', or 'diamond'. Defaults to 'rectangle'."},
          x: { type: Type.NUMBER, description: "The initial horizontal position of the node's center on a 1200x800 canvas." },
          y: { type: Type.NUMBER, description: "The initial vertical position of the node's center." },
          width: { type: Type.NUMBER, description: "The initial width of the node. Should be large enough for the label." },
          height: { type: Type.NUMBER, description: "The initial height of the node. Should be large enough for the label and icon." },
          color: { type: Type.STRING, description: "Optional hex color code for the node's fill." },
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

export const systemPrompt = `You are an expert system architect. Your task is to generate a JSON representation of a software architecture diagram based on a user's prompt. The JSON must strictly adhere to the provided schema.

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
    - For a simple architecture (e.g., a 3-tier app), generate a MAXIMUM of 2-3 essential labels.
    - For complex architectures, generate a MAXIMUM of 4-6 labels.
    - Only add a label if it clarifies a major concept that is impossible to understand from the component icons and container labels alone.
5.  **Node Sizing:** Ensure the 'width' and 'height' for each node are sufficiently large to contain the 'label' text comfortably without truncation. For longer labels like "Smart Contract Interaction," use a wider 'width' (e.g., 180) and a taller 'height' (e.g., 90) to allow for text wrapping.
6.  **Shape Constraint (CRITICAL):** For this general architecture modeler, you MUST NOT use the 'neuron' type for any node, even if the topic is AI-related. The 'neuron' type is reserved for a different modeler. Instead, use appropriate, standard icons like 'llm', 'embedding-model', 'vector-database', etc. Use standard shapes like 'rectangle' or 'ellipse'.
`;


// --- CONTROLLER FUNCTIONS ---

export const handleGenerateDiagram = async (req: express.Request, res: express.Response) => {
    try {
        const user = await authenticateUser(req);
        if (!user) {
            return res.status(401).json({ error: 'Unauthorized: Invalid authentication token.' });
        }

        const { prompt, userApiKey } = req.body;
        
        // Check user's generation limit *before* making the API call
        if (!userApiKey) {
            const { allowed, error: limitError, generationBalance } = await canUserGenerate(user);
            if (!allowed) {
                const error = new Error(limitError);
                (error as any).generationBalance = generationBalance;
                throw error;
            }
        }
        
        const data = await aiService.generateJsonFromPrompt(
            systemPrompt, 
            `Generate the JSON for the following prompt: "${prompt}"`,
            responseSchema, 
            userApiKey
        );

        // Only consume a credit if a personal key was NOT used.
        const newGenerationBalance = userApiKey ? null : await consumeGenerationCredit(user);
        
        res.json({ diagram: data, newGenerationBalance });
    } catch (e: any) {
        if (e.message?.includes('GENERATION_LIMIT_EXCEEDED')) {
            return res.status(429).json({ error: 'GENERATION_LIMIT_EXCEEDED', generationBalance: e.generationBalance });
        }
        console.error(`[Backend Error] ${e.message}`);
        res.status(500).json({ error: e.message || 'An unexpected error occurred.' });
    }
};

export const handleGenerateNeuralNetwork = async (req: express.Request, res: express.Response) => {
    try {
        const user = await authenticateUser(req);
        if (!user) {
            return res.status(401).json({ error: 'Unauthorized: Invalid authentication token.' });
        }
        const { prompt, userApiKey } = req.body;

        if (!userApiKey) {
            const { allowed, error: limitError, generationBalance } = await canUserGenerate(user);
            if (!allowed) {
                const error = new Error(limitError);
                (error as any).generationBalance = generationBalance;
                throw error;
            }
        }
        
        const data = await aiService.generateJsonFromPrompt(
            systemPrompt, // Still use the base system prompt for context
            `Generate the JSON for the following neural network prompt: "${prompt}"`,
            neuralNetworkSchema,
            userApiKey
        );
        
        const newGenerationBalance = userApiKey ? null : await consumeGenerationCredit(user);
        
        res.json({ diagram: data, newGenerationBalance });
    } catch (e: any) {
         if (e.message?.includes('GENERATION_LIMIT_EXCEEDED')) {
            return res.status(429).json({ error: 'GENERATION_LIMIT_EXCEEDED', generationBalance: e.generationBalance });
        }
        console.error(`[Backend Error] ${e.message}`);
        res.status(500).json({ error: e.message || 'An unexpected error occurred.' });
    }
};

export const awsArchitectureSchema = {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING, description: "A concise title for the AWS architecture diagram." },
      architectureType: { type: Type.STRING, description: "The architecture type, should be 'AWS'." },
      nodes: {
        type: Type.ARRAY,
        description: "A list of all AWS components in the architecture.",
        items: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING, description: "A unique, kebab-case identifier for the node (e.g., 'ec2-instance-1')." },
            label: { type: Type.STRING, description: "The human-readable name of the component (e.g., 'EC2 Instance')." },
            type: { type: Type.STRING, description: "The AWS service type for icon mapping. Use AWS-specific types like 'aws-ec2', 'aws-s3', 'aws-rds', 'aws-vpc', 'aws-lambda', etc." },
            description: { type: Type.STRING, description: "A brief, one-sentence description of the node's purpose. Can be an empty string for purely visual elements." },
            shape: { type: Type.STRING, description: "Optional. The visual shape of the node. Can be 'rectangle', 'ellipse', or 'diamond'. Defaults to 'rectangle'."},
            x: { type: Type.NUMBER, description: "The initial horizontal position of the node's center on a 1200x800 canvas." },
            y: { type: Type.NUMBER, description: "The initial vertical position of the node's center." },
            width: { type: Type.NUMBER, description: "The initial width of the node. Should be large enough for the label." },
            height: { type: Type.NUMBER, description: "The initial height of the node. Should be large enough for the label and icon." },
            color: { type: Type.STRING, description: "Optional hex color code for the node's fill." },
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
            label: { type: Type.STRING, description: "Optional label for the connection to indicate data flow (e.g., 'HTTPS Request')." },
            style: { type: Type.STRING, description: "The line style. Can be 'solid', 'dotted', 'dashed', or 'double'." },
            thickness: { type: Type.STRING, description: "The thickness of the link. Can be 'thin', 'medium', 'thick'." },
            bidirectional: { type: Type.BOOLEAN, description: "If true, the link will have arrowheads on both ends." },
          },
          required: ["id", "source", "target"],
        },
      },
      containers: {
        type: Type.ARRAY,
        description: "A list of bounding boxes for logical groupings like VPCs, subnets, or availability zones.",
        items: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING, description: "A unique, kebab-case identifier for the container." },
            label: { type: Type.STRING, description: "The name of the grouping (e.g., 'VPC')." },
            type: { type: Type.STRING, description: "The type of container: 'vpc', 'availability-zone', or 'subnet'." },
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
  
  export const awsSystemPrompt = `You are an expert AWS architect. Your task is to generate a JSON representation of an AWS architecture diagram based on a user's prompt. The JSON must strictly adhere to the provided schema.
  
  **Layout Philosophy: The "Swimlane" Principle**
  For any diagram with logical tiers (e.g., Presentation, Application, Data), you MUST adopt a strict, columnar (swimlane) layout. This is your highest priority for achieving a professional look.
  1.  **Tier Containers as Swimlanes:** Each logical tier MUST be represented by a \`container\` of type 'subnet' or 'availability-zone'. These containers should be arranged side-by-side (horizontally) and should ideally span the full vertical height of the main diagram area to create distinct visual columns.
  2.  **Strict Data Flow:** The primary data flow MUST proceed from left to right across these swimlanes. A user should be able to understand the sequence of operations just by looking at the layout.
  3.  **Alignment is Key:** Within each tier (swimlane), align the nodes vertically. This creates a clean, organized, grid-like structure. Strive for consistent spacing between nodes.
  4.  **Clean Link Routing:** Route links as cleanly as possible. Minimize crossovers. Links should primarily flow from a node in one tier to a node in the next tier to the right.
  
  **AWS-Specific Instructions:**
  1.  **Icon Mapping:** Choose the most appropriate 'type' for each node from the AWS-specific list in the schema. This is crucial for correct icon rendering. Use types like 'aws-ec2', 'aws-s3', 'aws-rds', 'aws-vpc', 'aws-lambda', etc.
  2.  **IDs:** All 'id' fields for nodes, links, and containers must be unique and in kebab-case.
  3.  **Connections:** Ensure all 'source' and 'target' fields in the 'links' array correspond to valid node 'id's.
  4.  **Labels (Crucial):** BE EXTREMELY CONSERVATIVE WITH LABELS. The user wants clean diagrams.
      - DO NOT use link labels for common interactions like 'API Call' or 'HTTPS Request'. The connection itself implies this.
      - DO NOT use floating text labels (\`layer-label\` or \`group-label\`) to label a tier if it is already inside a labeled container. The container's label is sufficient.
      - For a simple architecture (e.g., a 3-tier app), generate a MAXIMUM of 2-3 essential labels.
      - For complex architectures, generate a MAXIMUM of 4-6 labels.
      - Only add a label if it clarifies a major concept that is impossible to understand from the component icons and container labels alone.
  5.  **Node Sizing:** Ensure the 'width' and 'height' for each node are sufficiently large to contain the 'label' text comfortably without truncation. For longer labels like "Smart Contract Interaction," use a wider 'width' (e.g., 180) and a taller 'height' (e.g., 90) to allow for text wrapping.
  6.  **Shape Constraint (CRITICAL):** For this AWS architecture modeler, you MUST NOT use the 'neuron' type for any node. The 'neuron' type is reserved for neural networks. Instead, use appropriate AWS service types like 'aws-ec2', 'aws-s3', 'aws-rds', etc.
  `;
  
  export const handleGenerateAwsArchitecture = async (req: express.Request, res: express.Response) => {
    try {
        const user = await authenticateUser(req);
        if (!user) {
            return res.status(401).json({ error: 'Unauthorized: Invalid authentication token.' });
        }
        
        const { prompt, userApiKey } = req.body;
        
        // Check user's generation limit *before* making the API call
        if (!userApiKey) {
            const { allowed, error: limitError, generationBalance } = await canUserGenerate(user);
            if (!allowed) {
                const error = new Error(limitError);
                (error as any).generationBalance = generationBalance;
                throw error;
            }
        }
        
        const data = await aiService.generateJsonFromPrompt(
            awsSystemPrompt, 
            `Generate the JSON for the following AWS architecture prompt: "${prompt}"`,
            awsArchitectureSchema, 
            userApiKey
        );
        
        // Only consume a credit if a personal key was NOT used.
        const newGenerationBalance = userApiKey ? null : await consumeGenerationCredit(user);
        
        res.json({ diagram: data, newGenerationBalance });
    } catch (e: any) {
        if (e.message?.includes('GENERATION_LIMIT_EXCEEDED')) {
            return res.status(429).json({ error: 'GENERATION_LIMIT_EXCEEDED', generationBalance: e.generationBalance });
        }
        console.error(`[Backend Error] ${e.message}`);
        res.status(500).json({ error: e.message || 'An unexpected error occurred.' });
    }
  };
  
  export const handleExplainArchitecture = async (req: express.Request, res: express.Response) => {
    try {
        const user = await authenticateUser(req);
        if (!user) {
            return res.status(401).json({ error: 'Unauthorized: You must be logged in to use this feature.' });
        }
        
        const { diagramData, userApiKey } = req.body;
        
        const prompt = `Based on the following JSON data representing an architecture diagram, provide a concise, markdown-formatted explanation of what the system does, its key components, and how they interact. JSON: ${JSON.stringify(diagramData)}`;
        const explanation = await aiService.generateTextFromPrompt('', prompt, userApiKey);
        res.json({ explanation });
    } catch (e: any) {
        console.error(`[Backend Error] ${e.message}`);
        res.status(500).json({ error: e.message || 'An unexpected error occurred.' });
    }
};
