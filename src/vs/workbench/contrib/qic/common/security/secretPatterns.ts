/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface SecretPatternDefinition {
	name: string;
	prefix: string;
	pattern: RegExp;
	testString: string;
	severity: 'high' | 'medium' | 'low';
	contextRequired?: RegExp;
}

/**
 * 60+ secret detection patterns. Each has a prefix for fast Aho-Corasick
 * pre-filtering and a full regex for validation.
 */
export const SECRET_PATTERNS: SecretPatternDefinition[] = [
	// === AWS ===
	{ name: 'aws-access-key', prefix: 'AKIA', pattern: /AKIA[0-9A-Z]{16}/, testString: 'AKIA' + 'IOSFODNN7EXAMPLE', severity: 'high' },
	{ name: 'aws-secret-key', prefix: '', pattern: /(?:aws_secret_access_key|secret_access_key)\s*[=:]\s*[A-Za-z0-9/+=]{40}/, testString: 'aws_secret_access_key=wJalrXUtn' + 'FEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', severity: 'high' },
	{ name: 'aws-session-token', prefix: 'FwoGZX', pattern: /FwoGZX[A-Za-z0-9/+=]{100,}/, testString: 'FwoGZXIvYXdzEA0aDHQa7e' + 'PqFsDmExampleLongToken', severity: 'high' },

	// === GCP ===
	{ name: 'gcp-api-key', prefix: 'AIza', pattern: /AIza[0-9A-Za-z_-]{35}/, testString: 'AIza' + 'SyC3Nk0BJ_EXAMPLE_KEY_1234567890', severity: 'high' },
	{ name: 'gcp-service-account', prefix: '"type": "service_account"', pattern: /"type"\s*:\s*"service_account"/, testString: '"type": "ser' + 'vice_account"', severity: 'high' },

	// === Azure ===
	{ name: 'azure-storage-key', prefix: 'DefaultEndpointsProtocol', pattern: /DefaultEndpointsProtocol=https?;AccountName=[^;]+;AccountKey=[A-Za-z0-9/+=]{88}/, testString: 'DefaultEndpointsProtocol=https;Acco' + 'untName=test;AccountKey=dGVzdGtleQ==', severity: 'high' },
	{ name: 'azure-sas-token', prefix: 'sv=', pattern: /sv=\d{4}-\d{2}-\d{2}&s[a-z]=[a-z]+&s[a-z]{2}=[^&]+/, testString: 'sv=2021-06-08&ss=bfq' + 't&srt=sco&sp=rwdlacup', severity: 'medium' },

	// === Anthropic ===
	{ name: 'anthropic-api-key', prefix: 'sk-ant-', pattern: /sk-ant-[a-zA-Z0-9_-]{80,}/, testString: 'sk-ant-api03-examplekeyvalue1234567890ab' + 'cdefghijklmnopqrstuvwxyz1234567890abcdef', severity: 'high' },

	// === OpenAI ===
	{ name: 'openai-api-key', prefix: 'sk-', pattern: /sk-[a-zA-Z0-9]{20,}T3BlbkFJ[a-zA-Z0-9]{20,}/, testString: 'sk-' + 'examplekey12345678T3BlbkFJexamplekey12345678', severity: 'high' },
	{ name: 'openai-api-key-v2', prefix: 'sk-proj-', pattern: /sk-proj-[a-zA-Z0-9_-]{40,}/, testString: 'sk-proj-examplekeyvalue1' + '234567890abcdefghijklmno', severity: 'high' },

	// === GitHub ===
	{ name: 'github-pat', prefix: 'ghp_', pattern: /ghp_[a-zA-Z0-9]{36}/, testString: 'ghp_' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789', severity: 'high' },
	{ name: 'github-pat-fine', prefix: 'github_pat_', pattern: /github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/, testString: 'github_pat_' + '1234567890abcdefghijkl_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', severity: 'high' },
	{ name: 'github-oauth', prefix: 'gho_', pattern: /gho_[a-zA-Z0-9]{36}/, testString: 'gho_' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789', severity: 'high' },
	{ name: 'github-app-token', prefix: 'ghs_', pattern: /ghs_[a-zA-Z0-9]{36}/, testString: 'ghs_' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789', severity: 'high' },

	// === GitLab ===
	{ name: 'gitlab-pat', prefix: 'glpat-', pattern: /glpat-[a-zA-Z0-9_-]{20,}/, testString: 'glpat-' + 'ABCDEFGHIJKLMNOPqrst', severity: 'high' },
	{ name: 'gitlab-runner', prefix: 'GR1348941', pattern: /GR1348941[a-zA-Z0-9_-]{20,}/, testString: 'GR1348941ABCDE' + 'FGHIJKLMNOPqrst', severity: 'high' },

	// === Slack ===
	{ name: 'slack-bot-token', prefix: 'xoxb-', pattern: /xoxb-\d{10,}-[a-zA-Z0-9-]+/, testString: 'xoxb-' + '1234567890-abcdefghij', severity: 'high' },
	{ name: 'slack-user-token', prefix: 'xoxp-', pattern: /xoxp-\d{10,}-[a-zA-Z0-9-]+/, testString: 'xoxp-' + '1234567890-abcdefghij', severity: 'high' },
	{ name: 'slack-webhook', prefix: 'hooks.slack.com', pattern: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[a-zA-Z0-9]+/, testString: 'hooks.slack.c' + 'om/services/T' + '00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX', severity: 'medium' },

	// === Stripe ===
	{ name: 'stripe-live-key', prefix: 'sk_live_', pattern: /sk_live_[a-zA-Z0-9]{24,}/, testString: 'sk_live_' + '1234567890abcdefghijklmn', severity: 'high' },
	{ name: 'stripe-test-key', prefix: 'sk_test_', pattern: /sk_test_[a-zA-Z0-9]{24,}/, testString: 'sk_test_' + '1234567890abcdefghijklmn', severity: 'low' },
	{ name: 'stripe-publishable', prefix: 'pk_live_', pattern: /pk_live_[a-zA-Z0-9]{24,}/, testString: 'pk_live_' + '1234567890abcdefghijklmn', severity: 'medium' },

	// === Twilio ===
	{ name: 'twilio-api-key', prefix: 'SK', pattern: /SK[a-f0-9]{32}/, testString: 'SK' + '1234567890abcdef1234567890abcdef', severity: 'high' },

	// === SendGrid ===
	{ name: 'sendgrid-api-key', prefix: 'SG.', pattern: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/, testString: 'SG.' + 'abcdefghijklmnopqrstuv.1234567890abcdefghijklmnopqrstuvwxyz1234567', severity: 'high' },

	// === NPM ===
	{ name: 'npm-token', prefix: 'npm_', pattern: /npm_[a-zA-Z0-9]{36}/, testString: 'npm_' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789', severity: 'high' },

	// === PyPI ===
	{ name: 'pypi-token', prefix: 'pypi-', pattern: /pypi-[a-zA-Z0-9_-]{100,}/, testString: 'pypi-' + 'a'.repeat(100), severity: 'high' },

	// === HuggingFace ===
	{ name: 'huggingface-token', prefix: 'hf_', pattern: /hf_[a-zA-Z0-9]{34,}/, testString: 'hf_' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ01234567', severity: 'medium' },

	// === Private Keys ===
	{ name: 'private-key-rsa', prefix: '-----BEGIN RSA PRIVATE KEY', pattern: /-----BEGIN RSA PRIVATE KEY-----/, testString: '-----BEGIN RSA ' + 'PRIVATE KEY-----', severity: 'high' },
	{ name: 'private-key-ec', prefix: '-----BEGIN EC PRIVATE KEY', pattern: /-----BEGIN EC PRIVATE KEY-----/, testString: '-----BEGIN EC P' + 'RIVATE KEY-----', severity: 'high' },
	{ name: 'private-key-openssh', prefix: '-----BEGIN OPENSSH PRIVATE KEY', pattern: /-----BEGIN OPENSSH PRIVATE KEY-----/, testString: '-----BEGIN OPENSS' + 'H PRIVATE KEY-----', severity: 'high' },
	{ name: 'private-key-generic', prefix: '-----BEGIN PRIVATE KEY', pattern: /-----BEGIN PRIVATE KEY-----/, testString: '-----BEGIN PR' + 'IVATE KEY-----', severity: 'high' },
	{ name: 'pgp-private-key', prefix: '-----BEGIN PGP PRIVATE KEY', pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----/, testString: '-----BEGIN PGP PRI' + 'VATE KEY BLOCK-----', severity: 'high' },

	// === JWT ===
	{ name: 'jwt-token', prefix: 'eyJ', pattern: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+/, testString: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwI' + 'n0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', severity: 'high' },

	// === Bearer/Basic Auth ===
	{ name: 'bearer-token', prefix: 'Bearer ', pattern: /Bearer\s+[a-zA-Z0-9._~+/=-]{20,}/, testString: 'Bearer eyJhbGciOiJIUz' + 'I1NiIsInR5cCI6IkpXVCJ9', severity: 'medium' },
	{ name: 'basic-auth', prefix: 'Basic ', pattern: /Basic\s+[a-zA-Z0-9+/=]{20,}/, testString: 'Basic dXNlcjp' + 'wYXNzd29yZA==', severity: 'medium' },

	// === Connection Strings ===
	{ name: 'postgres-uri', prefix: 'postgres://', pattern: /postgres(?:ql)?:\/\/[^:]+:[^@]+@[^/]+\/\w+/, testString: 'postgres://user:' + 'pass@host:5432/db', severity: 'high' },
	{ name: 'mysql-uri', prefix: 'mysql://', pattern: /mysql:\/\/[^:]+:[^@]+@[^/]+\/\w+/, testString: 'mysql://user:pa' + 'ss@host:3306/db', severity: 'high' },
	{ name: 'mongodb-uri', prefix: 'mongodb', pattern: /mongodb(?:\+srv)?:\/\/[^:]+:[^@]+@[^\s]+/, testString: 'mongodb+srv://user:pass' + '@cluster.mongodb.net/db', severity: 'high' },
	{ name: 'redis-uri', prefix: 'redis://', pattern: /redis:\/\/[^:]*:[^@]+@[^\s]+/, testString: 'redis://:passw' + 'ord@host:6379/0', severity: 'high' },
	{ name: 'amqp-uri', prefix: 'amqp://', pattern: /amqps?:\/\/[^:]+:[^@]+@[^\s]+/, testString: 'amqp://user:p' + 'ass@host:5672/', severity: 'high' },

	// === Discord ===
	{ name: 'discord-bot-token', prefix: '', pattern: /[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}/, testString: 'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.abcde' + 'f.1234567890abcdefghijklmnopqrst', severity: 'high', contextRequired: /discord|bot|token/i },
	{ name: 'discord-webhook', prefix: 'discord.com/api/webhooks', pattern: /discord\.com\/api\/webhooks\/\d+\/[\w-]+/, testString: 'discord.com/api/webh' + 'ooks/123456789/abcdef', severity: 'medium' },

	// === Telegram ===
	{ name: 'telegram-bot-token', prefix: '', pattern: /\d{8,10}:[A-Za-z0-9_-]{35}/, testString: '123456789:ABCdefGHIjkl' + 'MNOpqrsTUVwxyz_1234567', severity: 'high', contextRequired: /telegram|bot/i },

	// === Mailgun ===
	{ name: 'mailgun-api-key', prefix: 'key-', pattern: /key-[a-f0-9]{32}/, testString: 'key-1234567890abcd' + 'ef1234567890abcdef', severity: 'high', contextRequired: /mailgun/i },

	// === Datadog ===
	{ name: 'datadog-api-key', prefix: '', pattern: /[a-f0-9]{32}/, testString: '1234567890abcdef' + '1234567890abcdef', severity: 'medium', contextRequired: /datadog|dd[-_]api/i },

	// === Hashicorp Vault ===
	{ name: 'vault-token', prefix: 'hvs.', pattern: /hvs\.[a-zA-Z0-9_-]{24,}/, testString: 'hvs.ABCDEFGHIJK' + 'LMNOPQRSTUVWXYZ', severity: 'high' },

	// === Supabase ===
	{ name: 'supabase-key', prefix: 'sbp_', pattern: /sbp_[a-f0-9]{40}/, testString: 'sbp_1234567890abcdef12' + '34567890abcdef12345678', severity: 'high' },

	// === Vercel ===
	{ name: 'vercel-token', prefix: '', pattern: /[a-zA-Z0-9]{24}/, testString: 'ABCDEFGHIJKL' + 'MNOPqrstuv12', severity: 'low', contextRequired: /vercel/i },

	// === Crypto / Mnemonics ===
	{ name: 'ethereum-private-key', prefix: '0x', pattern: /0x[a-fA-F0-9]{64}/, testString: '0x' + 'a'.repeat(64), severity: 'high', contextRequired: /private.?key|wallet|ethereum|eth/i },
	{ name: 'mnemonic-phrase', prefix: '', pattern: /\b(?:abandon|ability|able|about|above)\b(?:\s\S+){11,23}/, testString: 'abandon ability able about above absent ab' + 'sorb abstract absurd abuse access accident', severity: 'high', contextRequired: /mnemonic|seed|recovery|phrase/i },

	// === Quantlab-Specific ===
	{ name: 'alpaca-api-key', prefix: 'APCA-API-KEY-ID', pattern: /APCA-API-KEY-ID\s*[=:]\s*[A-Z0-9]{20}/, testString: 'APCA-API-KEY-ID=AB' + 'CDEFGHIJ1234567890', severity: 'high' },
	{ name: 'alpaca-secret', prefix: 'APCA-API-SECRET-KEY', pattern: /APCA-API-SECRET-KEY\s*[=:]\s*[a-zA-Z0-9/+=]{40}/, testString: 'APCA-API-SECRET-KEY=abcdefghij' + 'klmnopqrstuvwxyz12345678901234', severity: 'high' },
	{ name: 'ib-api-key', prefix: '', pattern: /\b[A-Z]\d{3,8}\b/, testString: 'U1234567', severity: 'medium', contextRequired: /interactive.?brokers?|ib[-_]?api|gateway/i },

	// === Generic patterns with context ===
	{ name: 'generic-api-key-assignment', prefix: 'api_key', pattern: /api[_-]?key\s*[=:]\s*['"][a-zA-Z0-9_-]{16,}['"]/, testString: 'api_key="abcdef' + 'ghij1234567890"', severity: 'medium' },
	{ name: 'generic-secret-assignment', prefix: 'secret', pattern: /(?:secret|password|passwd|token)\s*[=:]\s*['"][^'"]{8,}['"]/, testString: 'secret="my-supe' + 'r-secret-value"', severity: 'medium' },
	{ name: 'generic-password-url', prefix: '', pattern: /[a-z]+:\/\/[^:]+:[^@\s]+@/, testString: 'ftp://user' + ':pass@host', severity: 'medium' },

	// === SSH ===
	{ name: 'ssh-dsa-private', prefix: '-----BEGIN DSA PRIVATE KEY', pattern: /-----BEGIN DSA PRIVATE KEY-----/, testString: '-----BEGIN DSA ' + 'PRIVATE KEY-----', severity: 'high' },

	// === Env files ===
	{ name: 'env-secret-line', prefix: '', pattern: /^(?:export\s+)?(?:SECRET|PASSWORD|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY)\s*=\s*.+$/m, testString: 'SECRET=my_s' + 'ecret_value', severity: 'medium' },

	// === Cohere ===
	{ name: 'cohere-api-key', prefix: '', pattern: /[a-zA-Z0-9]{40}/, testString: 'a'.repeat(40), severity: 'low', contextRequired: /cohere/i },

	// === SSN (context-required) ===
	{ name: 'ssn-us', prefix: '', pattern: /\b\d{3}-\d{2}-\d{4}\b/, testString: '123-45-6789', severity: 'medium', contextRequired: /ssn|social\s*security|tax\s*id/i },

	// === Credit Card Numbers ===
	{ name: 'credit-card-visa', prefix: '4', pattern: /\b4\d{3}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, testString: '4111 1111' + ' 1111 1111', severity: 'high', contextRequired: /card|visa|credit|payment/i },
	{ name: 'credit-card-mastercard', prefix: '5', pattern: /\b5[1-5]\d{2}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, testString: '5500 0000' + ' 0000 0004', severity: 'high', contextRequired: /card|master|credit|payment/i },
];
