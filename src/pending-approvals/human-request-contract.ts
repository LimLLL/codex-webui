/** Admission and response contracts for the five implemented browser workflows. */
import {
  isBrowserRequestMethod,
  InvalidServerRequest,
} from '../codex/server-request-owner';
import type { IncomingServerRequest } from '../codex/server-request-owner';
import {
  encodePermissions,
  presentPermissions,
} from './permission-interaction';
import {
  encodeElicitation,
  presentElicitation,
} from './elicitation-interaction';
import { advertised, nonempty, onlyKeys, record } from './request-validation';

/** Rejects payloads a browser cannot retain, locate, or answer as a whole. */
export function validateHumanRequest(
  request: IncomingServerRequest,
): Record<string, unknown> {
  const params = record(request.params);
  if (
    !isBrowserRequestMethod(request.method) ||
    !params ||
    !nonempty(params.threadId)
  )
    throw new InvalidServerRequest();
  if (request.method === 'mcpServer/elicitation/request') {
    if (
      !(params.turnId === null || nonempty(params.turnId)) ||
      !nonempty(params.serverName) ||
      typeof params.message !== 'string'
    )
      throw new InvalidServerRequest();
  } else if (!nonempty(params.turnId) || !nonempty(params.itemId))
    throw new InvalidServerRequest();
  if (
    request.method === 'item/permissions/requestApproval' &&
    !nonempty(params.cwd)
  )
    throw new InvalidServerRequest();
  if (request.method === 'item/tool/requestUserInput') {
    if (!Array.isArray(params.questions) || !params.questions.length)
      throw new InvalidServerRequest();
    const ids = new Set<string>();
    for (const raw of params.questions) {
      const q = record(raw);
      if (
        !q ||
        !nonempty(q.id) ||
        ids.has(q.id) ||
        typeof q.header !== 'string' ||
        !nonempty(q.question) ||
        typeof q.isOther !== 'boolean' ||
        typeof q.isSecret !== 'boolean' ||
        (q.options != null &&
          (!Array.isArray(q.options) ||
            !q.options.every((value: unknown) => {
              const option = record(value);
              return (
                option &&
                nonempty(option.label) &&
                typeof option.description === 'string'
              );
            })))
      )
        throw new InvalidServerRequest();
      ids.add(q.id);
    }
  }
  return params;
}

/** Returns a typed interaction surface only for permissions and MCP requests. */
export function presentInteraction(
  method: string,
  params: Record<string, unknown>,
) {
  if (method === 'item/permissions/requestApproval')
    return presentPermissions(params);
  if (method === 'mcpServer/elicitation/request')
    return presentElicitation(params);
  return null;
}

/** Prevents command approval when a semantic field cannot be safely displayed. */
export function negativeOnlyReason(
  method: string,
  params: Record<string, unknown>,
): string | null {
  if (method !== 'item/commandExecution/requestApproval') return null;
  const network = record(params.networkApprovalContext);
  if (
    params.networkApprovalContext != null &&
    (!network ||
      !onlyKeys(network, ['host', 'protocol']) ||
      !nonempty(network.host) ||
      typeof network.protocol !== 'string' ||
      !['http', 'https', 'socks5Tcp', 'socks5Udp'].includes(network.protocol))
  )
    return 'This client cannot interpret the complete network approval subject.';
  if (!nonempty(params.command) && !network)
    return 'The command approval subject is unavailable. Only Decline or Cancel is available.';
  if (
    params.kind !== undefined &&
    params.kind !== 'command' &&
    params.kind !== 'writeStdin'
  )
    return 'This client cannot interpret this command approval kind.';
  if (
    params.additionalPermissions != null &&
    !presentPermissions({ permissions: params.additionalPermissions }).supported
  )
    return 'This client cannot interpret the complete requested permission scope.';
  if (
    params.availableDecisions != null &&
    (!Array.isArray(params.availableDecisions) ||
      params.availableDecisions.length === 0 ||
      !params.availableDecisions.every((value: unknown) =>
        validCommandDecision(value),
      ))
  )
    return 'This client cannot interpret the available approval decisions.';
  return null;
}

/** Recognizes the complete command decision grammar, without loose object matching. */
function validCommandDecision(value: unknown): boolean {
  if (typeof value === 'string')
    return ['accept', 'acceptForSession', 'decline', 'cancel'].includes(value);
  const decision = record(value);
  if (!decision) return false;
  const exec = record(decision.acceptWithExecpolicyAmendment);
  if (
    onlyKeys(decision, ['acceptWithExecpolicyAmendment']) &&
    exec &&
    onlyKeys(exec, ['execpolicy_amendment'])
  )
    return (
      Array.isArray(exec.execpolicy_amendment) &&
      exec.execpolicy_amendment.every((v) => typeof v === 'string')
    );
  const network = record(
    record(decision.applyNetworkPolicyAmendment)?.network_policy_amendment,
  );
  return (
    onlyKeys(decision, ['applyNetworkPolicyAmendment']) &&
    !!network &&
    onlyKeys(network, ['host', 'action']) &&
    nonempty(network.host) &&
    ['allow', 'deny'].includes(String(network.action))
  );
}

/** Validates browser input against the original request before encoding a wire response. */
export function encodeHumanResponse(
  method: string,
  params: Record<string, unknown>,
  value: unknown,
): unknown {
  if (method === 'item/permissions/requestApproval')
    return encodePermissions(params, value);
  if (method === 'mcpServer/elicitation/request')
    return encodeElicitation(params, value);
  const result = record(value);
  if (!result) throw new Error('Invalid server-request response');
  if (method === 'item/tool/requestUserInput') {
    const answers = record(result.answers);
    const questions = params.questions as Array<{ id: string }>;
    if (
      !onlyKeys(result, ['answers']) ||
      !answers ||
      !onlyKeys(
        answers,
        questions.map((q) => q.id),
      ) ||
      !questions.every((q) => {
        const answer = record(answers[q.id]);
        return (
          answer &&
          onlyKeys(answer, ['answers']) &&
          Array.isArray(answer.answers) &&
          answer.answers.length > 0 &&
          answer.answers.every(nonempty)
        );
      })
    )
      throw new Error('Invalid answers to the requested questions');
    return { answers };
  }
  if (!onlyKeys(result, ['decision']))
    throw new Error('Invalid approval response');
  const decision = result.decision;
  if (decision === 'decline' || decision === 'cancel') return { decision };
  if (negativeOnlyReason(method, params))
    throw new Error('This request can only be declined or cancelled');
  if (method === 'item/fileChange/requestApproval') {
    if (decision !== 'accept' && decision !== 'acceptForSession')
      throw new Error('Invalid file approval decision');
  } else if (method === 'item/commandExecution/requestApproval') {
    if (!validCommandDecision(decision))
      throw new Error('Invalid command approval decision');
    const options: unknown[] = Array.isArray(params.availableDecisions)
      ? params.availableDecisions
      : [
          'accept',
          'acceptForSession',
          ...(Array.isArray(params.proposedExecpolicyAmendment)
            ? [
                {
                  acceptWithExecpolicyAmendment: {
                    execpolicy_amendment: params.proposedExecpolicyAmendment,
                  },
                },
              ]
            : []),
          ...(Array.isArray(params.proposedNetworkPolicyAmendments)
            ? params.proposedNetworkPolicyAmendments.map(
                (amendment: unknown) => ({
                  applyNetworkPolicyAmendment: {
                    network_policy_amendment: amendment,
                  },
                }),
              )
            : []),
        ];
    if (!advertised(decision, options))
      throw new Error('The command decision was not offered by this request');
  } else throw new Error('Unsupported browser response method');
  return { decision };
}
