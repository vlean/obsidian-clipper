export interface Template {
	id: string;
	name: string;
	behavior: 'create' | 'append-specific' | 'append-daily' | 'prepend-specific' | 'prepend-daily' | 'overwrite';
	noteNameFormat: string;
	path: string;
	noteContentFormat: string;
	properties: Property[];
	triggers?: string[];
	vault?: string;
	context?: string;
	/** Outline collection for this template; falls back to the default collection */
	outlineCollectionId?: string;
	/** Cached collection name, for display only */
	outlineCollectionName?: string;
}

export interface Property {
	id?: string;
	name: string;
	value: string;
	type?: string;
}

export interface ExtractedContent {
	[key: string]: string;
}

export interface PromptVariable {
	key: string;
	prompt: string;
	filters?: string;
}

export interface PropertyType {
	name: string;
	type: string;
	defaultValue?: string;
}

export interface Provider {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	apiKeyRequired?: boolean;
	presetId?: string;
}

export interface Rating {
	rating: number;
	date: string;
}

export type SaveBehavior = 'addToObsidian' | 'addToOutline' | 'saveFile' | 'copyToClipboard';

export interface OutlineSettings {
	/** Outline instance URL, e.g. https://app.getoutline.com or a self-hosted URL */
	baseUrl: string;
	/** Default collection new documents are created in */
	collectionId: string;
	/** Cached collection name, for display only */
	collectionName: string;
	/** Publish documents immediately instead of creating drafts */
	publish: boolean;
	/** Re-host remote images as Outline attachments */
	uploadImages: boolean;
	/** Post highlight notes as comments anchored to the highlighted text */
	syncComments: boolean;
	/** Insert empty paragraphs between blocks (Outline renders paragraphs with no margin) */
	paragraphSpacing: boolean;
	/** How the frontmatter is shown at the top of documents */
	frontmatterStyle: 'table' | 'callout' | 'code';
	/** Separate inline translations on bilingual pages */
	bilingualLayout: boolean;
	/** Use the page's `published` property as the document creation date */
	usePublishedDate: boolean;
	/** Map the template's note location (a/b/c) to nested parent documents */
	pathAsParent: boolean;
	/** Show a badge on the toolbar icon when the current page is already clipped to Outline */
	showClippedBadge: boolean;
}

export interface ReaderSettings {
	fontSize: number;
	lineHeight: number;
	maxWidth: number;
	lightTheme: string;
	darkTheme: string;
	appearance: 'auto' | 'light' | 'dark';
	fonts: string[];
	defaultFont: string;
	blendImages: boolean;
	colorLinks: boolean;
	followLinks: boolean;
	pinPlayer: boolean;
	autoScroll: boolean;
	highlightActiveLine: boolean;
	customCss: string;
}

export interface Settings {
	vaults: string[];
	showMoreActionsButton: boolean;
	betaFeatures: boolean;
	legacyMode: boolean;
	silentOpen: boolean;
	openBehavior: 'popup' | 'embedded' | 'reader';
	highlighterEnabled: boolean;
	alwaysShowHighlights: boolean;
	highlightBehavior: string;
	interpreterModel?: string;
	models: ModelConfig[];
	providers: Provider[];
	interpreterEnabled: boolean;
	interpreterAutoRun: boolean;
	defaultPromptContext: string;
	propertyTypes: PropertyType[];
	readerSettings: ReaderSettings;
	stats: {
		addToObsidian: number;
		addToOutline: number;
		saveFile: number;
		copyToClipboard: number;
		share: number;
		readerMode: number;
	};
	history: HistoryEntry[];
	ratings: Rating[];
	saveBehavior: SaveBehavior;
	outline: OutlineSettings;
}

export interface ModelConfig {
	id: string;
	providerId: string;
	providerModelId: string;
	name: string;
	enabled: boolean;
}

export interface HistoryEntry {
	datetime: string;
	url: string;
	action: 'addToObsidian' | 'addToOutline' | 'saveFile' | 'copyToClipboard' | 'share' | 'readerMode';
	title?: string;
	vault?: string;
	path?: string;
}

export interface ConversationMessage {
	author: string;
	content: string;
	timestamp?: string;
	metadata?: Record<string, any>;
}

export interface ConversationMetadata {
	title?: string;
	description?: string;
	site: string;
	url: string;
	messageCount: number;
	startTime?: string;
	endTime?: string;
}

export interface Footnote {
	url: string;
	text: string;
}
