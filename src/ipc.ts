import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  CONNECTOR_CALLBACK_BASE_URL,
  DATA_DIR,
  IPC_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import {
  beginAuth,
  disconnect,
  getConnectionById,
  getConnectionStatus,
  listForGroup,
  listAvailableIntegrations,
  resolve,
  setAccess,
} from './connectors/index.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
}

// Find the chat JID for a group folder to send connector reply messages
function findJidForFolder(
  folder: string,
  registeredGroups: Record<string, RegisteredGroup>,
): string | undefined {
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.folder === folder) return jid;
  }
  return undefined;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For connector operations
    integration?: string;
    connection_id?: string;
    account_label?: string;
    target_group_folder?: string;
    enabled?: boolean;
    preferred_connection_id?: string;
    reply_jid?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    // --- Connector operations ---

    case 'connector_begin_auth': {
      const integration = data.integration;
      const replyJid =
        data.reply_jid ??
        findJidForFolder(sourceGroup, deps.registeredGroups());

      if (!integration) {
        logger.warn(
          { sourceGroup },
          'connector_begin_auth missing integration',
        );
        break;
      }
      if (!replyJid) {
        logger.warn(
          { sourceGroup },
          'connector_begin_auth: cannot find reply JID',
        );
        break;
      }

      try {
        const result = beginAuth(
          integration,
          sourceGroup,
          CONNECTOR_CALLBACK_BASE_URL,
          data.account_label,
        );
        await deps.sendMessage(replyJid, result.message);
        logger.info(
          { sourceGroup, integration, connectionId: result.connectionId },
          'connector_begin_auth: auth URL sent',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await deps.sendMessage(replyJid, `Could not start connection: ${msg}`);
        logger.error(
          { sourceGroup, integration, err },
          'connector_begin_auth failed',
        );
      }
      break;
    }

    case 'connector_check_status': {
      const connectionId = data.connection_id;
      const replyJid =
        data.reply_jid ??
        findJidForFolder(sourceGroup, deps.registeredGroups());

      if (!connectionId) {
        logger.warn(
          { sourceGroup },
          'connector_check_status missing connection_id',
        );
        break;
      }
      if (!replyJid) {
        logger.warn(
          { sourceGroup },
          'connector_check_status: cannot find reply JID',
        );
        break;
      }

      const statusInfo = getConnectionStatus(connectionId);
      if (!statusInfo) {
        await deps.sendMessage(
          replyJid,
          `Connection "${connectionId}" not found.`,
        );
        break;
      }

      // Verify the calling group has access to this connection
      const conn = getConnectionById(connectionId);
      const groupConnections = listForGroup(
        sourceGroup,
        statusInfo.integration,
      );
      const hasAccess =
        isMain || groupConnections.some((c) => c.id === connectionId);
      if (!hasAccess && conn?.requested_by_group !== sourceGroup) {
        logger.warn(
          { sourceGroup, connectionId },
          'connector_check_status: access denied',
        );
        await deps.sendMessage(
          replyJid,
          `Access denied for connection "${connectionId}".`,
        );
        break;
      }

      const statusEmoji: Record<string, string> = {
        connected: 'Connected',
        pending: 'Pending',
        expired: 'Token expired (needs reconnect)',
        failed: 'Failed',
        revoked: 'Disconnected',
      };
      const label = statusEmoji[statusInfo.status] ?? statusInfo.status;
      await deps.sendMessage(
        replyJid,
        `*${statusInfo.integration}* (${statusInfo.account_label}): ${label}`,
      );
      break;
    }

    case 'connector_list': {
      const replyJid =
        data.reply_jid ??
        findJidForFolder(sourceGroup, deps.registeredGroups());

      if (!replyJid) {
        logger.warn({ sourceGroup }, 'connector_list: cannot find reply JID');
        break;
      }

      if (isMain && !data.integration) {
        // Main sees all available integrations in the registry
        const entries = listAvailableIntegrations();
        if (entries.length === 0) {
          await deps.sendMessage(
            replyJid,
            'No integrations are currently configured. Core NanoClaw works without connectors; when needed, register provider credentials in OneCLI (connector/client/gmail, connector/client/github) to enable connector features.',
          );
          break;
        }
        const lines = entries.map(
          (e) => `• *${e.display_name}* (\`${e.integration}\`)`,
        );
        await deps.sendMessage(
          replyJid,
          `Available integrations:\n${lines.join('\n')}`,
        );
      } else {
        // All groups see their own enabled connections
        const connections = listForGroup(sourceGroup, data.integration);
        if (connections.length === 0) {
          const hint = data.integration
            ? `No ${data.integration} connection available for your group.`
            : 'No connections available for your group.';
          await deps.sendMessage(replyJid, hint);
          break;
        }
        const lines = connections.map(
          (c) =>
            `• *${c.integration}* — ${c.account_label} (${c.status}) [${c.id}]`,
        );
        await deps.sendMessage(
          replyJid,
          `Your connections:\n${lines.join('\n')}`,
        );
      }
      break;
    }

    case 'connector_use': {
      // Used by agents to resolve which account to use for an integration.
      // Writes a resolution snapshot file back to the IPC input dir for the agent to read.
      const integration = data.integration;
      const replyJid =
        data.reply_jid ??
        findJidForFolder(sourceGroup, deps.registeredGroups());

      if (!integration) {
        logger.warn({ sourceGroup }, 'connector_use missing integration');
        break;
      }

      const result = await resolve(
        integration,
        sourceGroup,
        data.preferred_connection_id,
      );

      if (result.type === 'resolved') {
        // Write access_token to group IPC input dir for the container to read
        const DATA_DIR_path = path.join(
          DATA_DIR,
          'ipc',
          sourceGroup,
          'input',
          `connector-${integration}-${Date.now()}.json`,
        );
        try {
          fs.mkdirSync(path.dirname(DATA_DIR_path), { recursive: true });
          fs.writeFileSync(
            DATA_DIR_path,
            JSON.stringify({
              type: 'connector_token',
              integration,
              connection_id: result.connection.id,
              account_label: result.connection.account_label,
              access_token: result.access_token,
            }),
          );
        } catch (err) {
          logger.error(
            { err, sourceGroup },
            'Failed to write connector token to IPC input',
          );
        }
      } else if (result.type === 'ACCOUNT_SELECTION_REQUIRED' && replyJid) {
        const lines = result.accounts.map(
          (a, i) => `${i + 1}. ${a.account_label} (${a.connection_id})`,
        );
        await deps.sendMessage(
          replyJid,
          `Multiple ${integration} accounts available. Which would you like to use?\n${lines.join('\n')}\n\nReply with the account number or connection ID.`,
        );
      } else if (result.type === 'INTEGRATION_NOT_CONNECTED' && replyJid) {
        await deps.sendMessage(
          replyJid,
          `No ${integration} connection found for your group. Use \`connector_begin_auth\` to connect.`,
        );
      } else if (result.type === 'CONNECTION_EXPIRED' && replyJid) {
        await deps.sendMessage(
          replyJid,
          `Your ${integration} connection has expired. Please reconnect using \`connector_begin_auth\`.`,
        );
      }

      logger.info(
        { sourceGroup, integration, resultType: result.type },
        'connector_use resolved',
      );
      break;
    }

    case 'connector_disconnect': {
      const connectionId = data.connection_id;
      const replyJid =
        data.reply_jid ??
        findJidForFolder(sourceGroup, deps.registeredGroups());

      if (!connectionId) {
        logger.warn(
          { sourceGroup },
          'connector_disconnect missing connection_id',
        );
        break;
      }

      try {
        await disconnect(connectionId, sourceGroup, isMain);
        if (replyJid) {
          await deps.sendMessage(
            replyJid,
            `Connection "${connectionId}" disconnected.`,
          );
        }
        logger.info(
          { sourceGroup, connectionId },
          'connector_disconnect: done',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (replyJid)
          await deps.sendMessage(replyJid, `Disconnect failed: ${msg}`);
        logger.error(
          { sourceGroup, connectionId, err },
          'connector_disconnect failed',
        );
      }
      break;
    }

    case 'connector_set_access': {
      // Only main group can toggle access for groups other than self
      const connectionId = data.connection_id;
      const targetGroupFolder = data.target_group_folder;
      const enabled = data.enabled;
      const replyJid =
        data.reply_jid ??
        findJidForFolder(sourceGroup, deps.registeredGroups());

      if (!connectionId || !targetGroupFolder || enabled === undefined) {
        logger.warn(
          { sourceGroup },
          'connector_set_access missing required fields',
        );
        break;
      }

      try {
        setAccess(
          connectionId,
          targetGroupFolder,
          enabled,
          sourceGroup,
          isMain,
        );
        if (replyJid) {
          await deps.sendMessage(
            replyJid,
            `Connector access ${enabled ? 'granted to' : 'revoked from'} group "${targetGroupFolder}".`,
          );
        }
        logger.info(
          { sourceGroup, connectionId, targetGroupFolder, enabled },
          'connector_set_access: done',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (replyJid)
          await deps.sendMessage(replyJid, `Set access failed: ${msg}`);
        logger.error(
          { sourceGroup, connectionId, err },
          'connector_set_access failed',
        );
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
