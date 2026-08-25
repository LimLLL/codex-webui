/**
 * Hierarchical error codes for all API error responses.
 * Frontend uses these codes as i18n keys: t(`error.${errorCode}`, { ...params }).
 */
export const ErrorCode = {
  // ── HTTP status fallbacks (for unmigrated NestJS exceptions) ──────
  http: {
    badRequest: 'http.bad_request',
    unauthorized: 'http.unauthorized',
    forbidden: 'http.forbidden',
    notFound: 'http.not_found',
    conflict: 'http.conflict',
    payloadTooLarge: 'http.payload_too_large',
    requestFailed: 'http.request_failed',
    internalError: 'http.internal_error',
  },

  // ── Common validation ─────────────────────────────────────────────
  validation: {
    /** Generic "{field} is required". Params: { field } */
    fieldRequired: 'validation.field_required',
    /** Generic "Request body is required". */
    bodyRequired: 'validation.body_required',
    /** Generic "{field} must be a {type}". Params: { field, type } */
    typeMismatch: 'validation.type_mismatch',
    /** Generic "{field} is invalid". Params: { field } */
    fieldInvalid: 'validation.field_invalid',
  },

  // ── Auth ───────────────────────────────────────────────────────────
  auth: {
    missingToken: 'auth.missing_token',
    invalidToken: 'auth.invalid_token',
    missingHeader: 'auth.missing_header',
    invalidApiKey: 'auth.invalid_api_key',
  },

  // ── Files ──────────────────────────────────────────────────────────
  files: {
    pathRequired: 'files.path_required',
    /** Params: { path } */
    pathNotFound: 'files.path_not_found',
    pathOutsideWorkspace: 'files.path_outside_workspace',
    pathTraversal: 'files.path_traversal',
    pathIsDirectory: 'files.path_is_directory',
    pathIsNotDirectory: 'files.path_is_not_directory',
    /** Params: { path } */
    pathExists: 'files.path_exists',
    nameRequired: 'files.name_required',
    nameInvalid: 'files.name_invalid',
    cannotOverwriteDir: 'files.cannot_overwrite_dir',
    notDownloadable: 'files.not_downloadable',
    uploadDirRequired: 'files.upload_dir_required',
    uploadFileRequired: 'files.upload_file_required',
    uploadTooLarge: 'files.upload_too_large',
    /** File exceeds read size limit (distinct from upload limit). */
    fileTooLarge: 'files.file_too_large',
    notWritable: 'files.not_writable',
    insufficientSpace: 'files.insufficient_space',
    workspaceRootNotDir: 'files.workspace_root_not_dir',
    parentNotDir: 'files.parent_not_dir',
    /** Params: { path } */
    noParentFound: 'files.no_parent_found',
    cannotModifyRoot: 'files.cannot_modify_root',
    dirNotEmpty: 'files.dir_not_empty',
    uploadPathInvalid: 'files.upload_path_invalid',
    multipartUnavailable: 'files.multipart_unavailable',
    /** File was modified since the client last read it (mtime conflict). */
    modifiedSinceRead: 'files.modified_since_read',
    /** Params: { path } */
    overwriteDisabled: 'files.overwrite_disabled',
    /** Catch-all for OS-level file operation failures. */
    operationFailed: 'files.operation_failed',
    pathExistsNotDir: 'files.path_exists_not_dir',
    contentRequired: 'files.content_required',
    /** Params: { source, destination } */
    sourceAndDestRequired: 'files.source_and_dest_required',
    destRequired: 'files.dest_required',
  },

  // ── Terminal ───────────────────────────────────────────────────────
  terminal: {
    /** Params: { max } */
    maxSessionsReached: 'terminal.max_sessions_reached',
    exited: 'terminal.exited',
    inputTooLarge: 'terminal.input_too_large',
    invalidContext: 'terminal.invalid_context',
    /** Default terminal cwd is invalid or outside workspace roots. */
    invalidCwd: 'terminal.invalid_cwd',
    cwdRequired: 'terminal.cwd_required',
    cwdNotDirectory: 'terminal.cwd_not_directory',
    closed: 'terminal.closed',
    notFound: 'terminal.not_found',
    contextMismatch: 'terminal.context_mismatch',
    socketNotAttached: 'terminal.socket_not_attached',
  },

  // ── Threads ────────────────────────────────────────────────────────
  threads: {
    invalidLimit: 'threads.invalid_limit',
    invalidSortKey: 'threads.invalid_sort_key',
    invalidModel: 'threads.invalid_model',
    invalidEffort: 'threads.invalid_effort',
    invalidName: 'threads.invalid_name',
    invalidInput: 'threads.invalid_input',
    /** Params: { index } */
    invalidInputItem: 'threads.invalid_input_item',
    /** Params: { index } */
    invalidInputUrl: 'threads.invalid_input_url',
    /** Params: { index, field } */
    invalidInputField: 'threads.invalid_input_field',
    /** Params: { index } */
    invalidInputType: 'threads.invalid_input_type',
    invalidApprovalPolicy: 'threads.invalid_approval_policy',
    invalidSandboxMode: 'threads.invalid_sandbox_mode',
    paginatedHistoryRequired: 'threads.paginated_history_required',
    branchEditedTurnRequired: 'threads.branch_edited_turn_required',
    branchEditedTurnNotFound: 'threads.branch_edited_turn_not_found',
    branchEditedTurnNotUserMessage:
      'threads.branch_edited_turn_not_user_message',
    branchThreadInProgress: 'threads.branch_thread_in_progress',
    branchInvalidBoundary: 'threads.branch_invalid_boundary',
    branchForkUnsupported: 'threads.branch_fork_unsupported',
    branchPrefixMismatch: 'threads.branch_prefix_mismatch',
    branchMetadataFailed: 'threads.branch_metadata_failed',
    compactBlockedByDescendants: 'threads.compact_blocked_by_descendants',
    deleteScanNotReady: 'threads.delete_scan_not_ready',
    deleteTopologyConflict: 'threads.delete_topology_conflict',
    deletePlanChanged: 'threads.delete_plan_changed',
    deleteInProgress: 'threads.delete_in_progress',
    deleteInterruptFailed: 'threads.delete_interrupt_failed',
    deleteFailed: 'threads.delete_failed',
    deleteLocalCleanupFailed: 'threads.delete_local_cleanup_failed',
    deleteOrphanedLocalTopology: 'threads.delete_orphaned_local_topology',
    deleteThreadIdSetRequired: 'threads.delete_thread_id_set_required',
    threadIdsRequired: 'threads.thread_ids_required',
    invalidCollaborationMode: 'threads.invalid_collaboration_mode',
    collaborationModeUnavailable: 'threads.collaboration_mode_unavailable',
    collaborationModeModelRequired: 'threads.collaboration_mode_model_required',
    invalidGoal: 'threads.invalid_goal',
    invalidGoalStatus: 'threads.invalid_goal_status',
    invalidReviewTarget: 'threads.invalid_review_target',
    reviewDetachedUnsupported: 'threads.review_detached_unsupported',
    invalidForkOptions: 'threads.invalid_fork_options',
  },

  // ── Settings ───────────────────────────────────────────────────────
  settings: {
    /** Params: { key } */
    notFound: 'settings.not_found',
    updatesRequired: 'settings.updates_required',
    keyRequired: 'settings.key_required',
    /** Params: { key } */
    duplicateKey: 'settings.duplicate_key',
    /** Params: { key, type } */
    invalidValue: 'settings.invalid_value',
    /** Params: { key, min, max } */
    outOfRange: 'settings.out_of_range',
    /** Params: { key, values } */
    notInEnum: 'settings.not_in_enum',
    /** Params: { category } */
    invalidCategory: 'settings.invalid_category',
  },

  // ── OnlyOffice ─────────────────────────────────────────────────────
  onlyoffice: {
    notConfigured: 'onlyoffice.not_configured',
    jwtRequired: 'onlyoffice.jwt_required',
    fileRequired: 'onlyoffice.file_required',
    unsupportedFormat: 'onlyoffice.unsupported_format',
    missingCallbackState: 'onlyoffice.missing_callback_state',
    invalidCallbackState: 'onlyoffice.invalid_callback_state',
    invalidCallbackStatePayload: 'onlyoffice.invalid_callback_state_payload',
    missingCallbackJwt: 'onlyoffice.missing_callback_jwt',
    invalidCallbackJwt: 'onlyoffice.invalid_callback_jwt',
    invalidDownloadUrl: 'onlyoffice.invalid_download_url',
    downloadUrlNotHttps: 'onlyoffice.download_url_not_https',
    downloadUrlOriginMismatch: 'onlyoffice.download_url_origin_mismatch',
    saveTooLarge: 'onlyoffice.save_too_large',
    saveNoBody: 'onlyoffice.save_no_body',
    /** Params: { label } */
    invalidUrl: 'onlyoffice.invalid_url',
    publicHostRequired: 'onlyoffice.public_host_required',
  },

  // ── Archive ────────────────────────────────────────────────────────
  archive: {
    invalidEntryPath: 'archive.invalid_entry_path',
    entryNotFound: 'archive.entry_not_found',
    entryNotFile: 'archive.entry_not_file',
    entryEncrypted: 'archive.entry_encrypted',
    entryUnsupported: 'archive.entry_unsupported',
    entrySizeUnknown: 'archive.entry_size_unknown',
    /** Params: { limit } */
    entryTooLarge: 'archive.entry_too_large',
    pathNotFile: 'archive.path_not_file',
    unsupportedFormat: 'archive.unsupported_format',
    tooManyEntries: 'archive.too_many_entries',
    unsafeEntryPath: 'archive.unsafe_entry_path',
    /** Params: { limit } */
    totalSizeTooLarge: 'archive.total_size_too_large',
    sevenZipUnavailable: 'archive.seven_zip_unavailable',
    rarUnavailable: 'archive.rar_unavailable',
    rarEntryNoStream: 'archive.rar_entry_no_stream',
  },

  // ── Chat / Upload ──────────────────────────────────────────────────
  chat: {
    multipartUnavailable: 'chat.multipart_unavailable',
    fileRequired: 'chat.file_required',
    filenameRequired: 'chat.filename_required',
    imagePathRequired: 'chat.image_path_required',
    imagePathAbsolute: 'chat.image_path_absolute',
    /** Params: { path } */
    uploadNotFound: 'chat.upload_not_found',
    imageOutsideRoot: 'chat.image_outside_root',
    imageNotFile: 'chat.image_not_file',
    /** Uploaded file is invalid (generic). */
    fileInvalid: 'chat.file_invalid',
  },

  // ── Codex Config ───────────────────────────────────────────────────
  codex: {
    rpcError: 'codex.rpc_error',
    serverUnavailable: 'codex.server_unavailable',
    rawContentInvalid: 'codex.raw_content_invalid',
    editsNotArray: 'codex.edits_not_array',
    /** Params: { index } */
    editInvalid: 'codex.edit_invalid',
    /** Params: { key } */
    keyUnsupported: 'codex.key_unsupported',
    /** Params: { key } */
    valueInvalid: 'codex.value_invalid',
    /** Params: { key } */
    valueInvalidJson: 'codex.value_invalid_json',
    /** Codex config write failed. */
    writeFailed: 'codex.write_failed',
    invalidFeedback: 'codex.invalid_feedback',
  },

  // ── Pending Approvals ──────────────────────────────────────────────
  approvals: {
    resultRequired: 'approvals.result_required',
    notFound: 'approvals.not_found',
    alreadyResolved: 'approvals.already_resolved',
    serverNotConnected: 'approvals.server_not_connected',
    alreadyHandled: 'approvals.already_handled',
  },

  // ── Skills ─────────────────────────────────────────────────────────
  skills: {
    cwdRequired: 'skills.cwd_required',
    pathOrNameRequired: 'skills.path_or_name_required',
  },

  // ── MCP Servers ────────────────────────────────────────────────────
  mcp: {
    invalidServerDetail: 'mcp.invalid_server_detail',
    scopesInvalid: 'mcp.scopes_invalid',
    scopesEmpty: 'mcp.scopes_empty',
    timeoutInvalid: 'mcp.timeout_invalid',
    /** Params: { max } */
    timeoutTooLarge: 'mcp.timeout_too_large',
  },

  // ── Account ────────────────────────────────────────────────────────
  account: {
    loginIdRequired: 'account.login_id_required',
    apiKeyRequired: 'account.api_key_required',
    accessTokenRequired: 'account.access_token_required',
    chatgptAccountIdRequired: 'account.chatgpt_account_id_required',
    invalidLoginType: 'account.invalid_login_type',
  },

  // ── Plugins ────────────────────────────────────────────────────────
  plugins: {
    /** Params: { field } */
    fieldRequired: 'plugins.field_required',
  },
} as const;

/** Recursive type utility that extracts all leaf string values from the ErrorCode tree. */
type NestedValues<T> = T extends string
  ? T
  : T extends object
    ? { [K in keyof T]: NestedValues<T[K]> }[keyof T]
    : never;

/** Union of all valid error code strings — constrains BusinessException at compile time. */
export type ErrorCodeValue = Extract<NestedValues<typeof ErrorCode>, string>;
