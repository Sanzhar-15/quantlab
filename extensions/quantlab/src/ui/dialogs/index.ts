/*---------------------------------------------------------------------------------------------
 *  Dialog Module Exports.
 *
 *  UI dialogs for trading operations.
 *
 *  Spec Reference: Technical Spec §12.3 (Safety Layer)
 *--------------------------------------------------------------------------------------------*/

export {
	showRecoveryDialog,
	showRecoveryNotification,
	showStartupRecoveryPrompt,
	type CrashedSession,
	type RecoveryAction,
	type RecoveryDialogResult,
} from './RecoveryDialog';

export {
	MasterKeyPrompt,
	registerMasterKeyCommands,
	type MasterKeyState,
	type MasterKeyConfig,
	type MasterKeyResult,
} from './MasterKeyPrompt';
