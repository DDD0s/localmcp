// Exit codes shared by the agent and the supervisors that restart it
// (systemd RestartPreventExitStatus and the Windows autostart supervisor).

/** Another authenticated agent took over this device. Restarting would take it back. */
export const EXIT_DISPLACED = 3;

/** Another agent already serves this ~/.localmcp directory. */
export const EXIT_ALREADY_RUNNING = 4;

/** Exit codes after which a supervisor must not restart the agent. 0 is a requested stop. */
export const FINAL_EXIT_CODES: readonly number[] = [0, EXIT_DISPLACED, EXIT_ALREADY_RUNNING];
