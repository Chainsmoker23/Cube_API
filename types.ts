
export interface ArchNode {
  id: string;
  label: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  description?: string;
  locked?: boolean;
  color?: string;
  animationOrder?: number;
  shape?: 'rectangle' | 'ellipse' | 'diamond';
  layer?: number;
}

export interface Link {
  id: string;
  source: string | ArchNode;
  target: string | ArchNode;
  label?: string;
  style?: 'solid' | 'dotted' | 'dashed' | 'double';
  color?: string;
  thickness?: 'thin' | 'medium' | 'thick';
  bidirectional?: boolean;
}

export interface Container {
  id:string;
  label: string;
  type: 'region' | 'availability-zone' | 'tier';
  x: number;
  y: number;
  width: number;
  height: number;
  childNodeIds: string[];
  description?: string;
  color?: string;
}

export interface DiagramData {
  title: string;
  architectureType: string;
  nodes: ArchNode[];
  links: Link[];
  containers?: Container[];
}

// These types are for your Graph/Chart modeler
export interface PieChartSlice {
  label: string;
  value: number;
  color: string;
}

export interface PieChartData {
  title: string;
  slices: PieChartSlice[];
}

export interface FunnelChartStage {
  label: string;
  value: number;
  color: string;
}

export interface FunnelChartData {
  title: string;
  stages: FunnelChartStage[];
}


// Note: The IconType enum is used by your frontend,
// but it is good practice to have it here for reference
// so the backend understands the 'type' string it needs to generate.
export enum IconType {
  // --- Standard AWS ---
  AwsEc2 = 'aws-ec2',
  AwsS3 = 'aws-s3',
  AwsRds = 'aws-rds',
  AwsLambda = 'aws-lambda',
  AwsApiGateway = 'aws-api-gateway',
  AwsLoadBalancer = 'aws-load-balancer',
  AwsCloudfront = 'aws-cloudfront',
  AwsEcs = 'aws-ecs',
  
  // --- Extended AWS ---
  AwsDynamoDb = 'aws-dynamodb',
  AwsSns = 'aws-sns',
  AwsSqs = 'aws-sqs',
  AwsEventbridge = 'aws-eventbridge',
  AwsCloudwatch = 'aws-cloudwatch',

  // --- Standard Azure ---
  AzureVm = 'azure-vm',
  AzureBlobStorage = 'azure-blob-storage',
  AzureSqlDatabase = 'azure-sql-database',

  // --- Extended Azure ---
  AzureAppService = 'azure-app-service',
  AzureFunctionApp = 'azure-function-app',
  AzureServiceBus = 'azure-service-bus',

  // --- Standard GCP ---
  GcpComputeEngine = 'gcp-compute-engine',
  GcpCloudStorage = 'gcp-cloud-storage',
  GcpCloudSql = 'gcp-cloud-sql',

  // --- Extended GCP ---
  GcpBigquery = 'gcp-bigquery',
  GcpPubsub = 'gcp-pubsub',

  // --- Containers & Orchestration ---
  Kubernetes = 'kubernetes',
  Docker = 'docker',

  // --- Messaging & Integration ---
  Kafka = 'kafka',
  MessageQueue = 'message-queue',
  EventBus = 'event-bus',
  ServiceMesh = 'service-mesh',

  // --- Analytics & Monitoring ---
  Monitoring = 'monitoring',
  Logging = 'logging',

  // --- Blockchain / Web3 ---
  BlockchainNode = 'blockchain-node',
  SmartContract = 'smart-contract',
  Wallet = 'wallet',
  Oracle = 'oracle',
  Ipfs = 'ipfs',
  
  // --- Development & Web ---
  Javascript = 'javascript',
  Nginx = 'nginx',
  ReactJs = 'react-js',
  NodeJs = 'node-js',
  Python = 'python',
  GoLang = 'go-lang',
  NextJs = 'next-js',
  ExpressJs = 'express-js',
  Dotenv = 'dotenv',
  C = 'c',
  Cpp = 'cpp',
  Swift = 'swift',
  
  // --- AI Models ---
  ChatGpt = 'chat-gpt',
  Gemini = 'gemini',
  Anthropic = 'anthropic',
  Grok = 'grok',
  
  // --- AI / ML ---
  Llm = 'llm',
  VectorDatabase = 'vector-database',
  EmbeddingModel = 'embedding-model',
  PromptManager = 'prompt-manager',
  DocumentLoader = 'document-loader',
  KnowledgeBase = 'knowledge-base',
  Gpu = 'gpu',
  ModelRegistry = 'model-registry',
  TrainingData = 'training-data',
  InferenceApi = 'inference-api',
  DataPreprocessing = 'data-preprocessing',
  Neuron = 'neuron',
  LayerLabel = 'layer-label',

  // --- Conceptual ---
  Brain = 'brain',
  Planning = 'planning',
  Perception = 'perception',
  Action = 'action',
  Environment = 'environment',
  Memory = 'memory',
  Interaction = 'interaction',
  WorldKnowledge = 'world-knowledge',
  InputEncoder = 'input-encoder',
  Simulation = 'simulation',
  Embody = 'embody',
  GroupLabel = 'group-label',

  // --- Databases ---
  Database = 'database',
  Sql = 'sql',
  MySql = 'mysql',
  Postgresql = 'postgresql',
  MongoDb = 'mongodb',
  DataStore = 'data-store',
  
  // --- Security ---
  Firewall = 'firewall',
  AuthService = 'auth-service',
  SecretsManager = 'secrets-manager',
  
  // --- Generic & Vendor ---
  User = 'user',
  WebServer = 'web-server',
  Api = 'api',
  Mobile = 'mobile',
  WebApp = 'web-app',
  LoadBalancer = 'load-balancer',
  Cache = 'cache',
  Cloud = 'cloud',
  ManagementConsole = 'management-console',
  Microsoft = 'microsoft',
  Google = 'google',
  Playground = 'playground',
  FileCode = 'file-code',
  Message = 'message',
  Sparkles = 'sparkles',
  Edit = 'edit',
  Gear = 'gear',
  Generic = 'generic',
}