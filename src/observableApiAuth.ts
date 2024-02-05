import * as clack from "@clack/prompts";
import type {ClackEffects} from "./clack.js";
import {commandInstruction} from "./commandInstruction.js";
import {CliError, isHttpError} from "./error.js";
import type {PostAuthRequestPollResponse} from "./observableApiClient.js";
import {ObservableApiClient, getObservableUiOrigin} from "./observableApiClient.js";
import type {ConfigEffects} from "./observableApiConfig.js";
import {
  type ApiKey,
  defaultEffects as defaultConfigEffects,
  getObservableApiKey,
  setObservableApiKey
} from "./observableApiConfig.js";
import type {TtyEffects} from "./tty.js";
import {bold, defaultEffects as defaultTtyEffects, green, inverse, link, yellow} from "./tty.js";

const OBSERVABLE_UI_ORIGIN = getObservableUiOrigin();

/** Actions this command needs to take wrt its environment that may need mocked out. */
export interface AuthEffects extends ConfigEffects, TtyEffects {
  clack: ClackEffects;
  getObservableApiKey: (effects: AuthEffects) => Promise<ApiKey>;
  setObservableApiKey: (info: {id: string; key: string} | null) => Promise<void>;
  exitSuccess: () => void;
}

const defaultEffects: AuthEffects = {
  ...defaultConfigEffects,
  ...defaultTtyEffects,
  clack,
  getObservableApiKey,
  setObservableApiKey,
  exitSuccess: () => process.exit(0)
};

export async function login(effects: AuthEffects = defaultEffects) {
  effects.clack.intro(green(inverse(" observable login ")));

  const apiClient = new ObservableApiClient();
  const requestInfo = await apiClient.postAuthRequest(["projects:deploy", "projects:create"]);
  const confirmUrl = new URL("/auth-device", OBSERVABLE_UI_ORIGIN);
  confirmUrl.searchParams.set("code", requestInfo.confirmationCode);

  effects.clack.log.step(
    `Your confirmation code is ${bold(yellow(requestInfo.confirmationCode))}\n` +
      `Open ${link(confirmUrl)}\nin your browser, and confirm the code matches.`
  );
  const spinner = effects.clack.spinner();
  spinner.start("Waiting for confirmation...");

  let apiKey: PostAuthRequestPollResponse["apiKey"] | null = null;
  while (apiKey === null) {
    const requestPoll = await apiClient.postAuthRequestPoll(requestInfo.id);
    switch (requestPoll.status) {
      case "pending":
        break;
      case "accepted":
        apiKey = requestPoll.apiKey;
        break;
      case "expired":
        spinner.stop("Failed to confirm code.", 2);
        throw new CliError("That confirmation code expired.");
      case "consumed":
        spinner.stop("Failed to confirm code.", 2);
        throw new CliError("That confirmation code has already been used.");
      default:
        spinner.stop("Failed to confirm code.", 2);
        throw new CliError(`Received an unknown polling status ${requestPoll.status}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!apiKey) throw new CliError("No API key returned from server.");
  await effects.setObservableApiKey(apiKey);

  apiClient.setApiKey({source: "login", key: apiKey.key});
  const user = await apiClient.getCurrentUser();
  spinner.stop(`You are logged into ${OBSERVABLE_UI_ORIGIN.hostname} as ${formatUser(user)}.`);
  if (user.workspaces.length === 0) {
    effects.clack.log.warn(`${yellow("Warning:")} You don't have any workspaces to deploy to.`);
  } else if (user.workspaces.length > 1) {
    clack.note(
      [
        "You have access to the following workspaces:",
        "",
        ...user.workspaces.map((workspace) => ` * ${formatUser(workspace)}`)
      ].join("\n")
    );
  }

  effects.clack.outro("🎉 Happy visualizing!");
}

export async function logout(effects = defaultEffects) {
  await effects.setObservableApiKey(null);
}

export async function whoami(effects = defaultEffects) {
  const {logger} = effects;
  const apiKey = await effects.getObservableApiKey(effects);
  const apiClient = new ObservableApiClient({apiKey});

  try {
    const user = await apiClient.getCurrentUser();
    logger.log();
    logger.log(`You are logged into ${OBSERVABLE_UI_ORIGIN.hostname} as ${formatUser(user)}.`);
    logger.log();
    logger.log("You have access to the following workspaces:");
    for (const workspace of user.workspaces) {
      logger.log(` * ${formatUser(workspace)}`);
    }
    logger.log();
  } catch (error) {
    if (isHttpError(error) && error.statusCode == 401) {
      if (apiKey.source === "env") {
        logger.log(`Your API key is invalid. Check the value of the ${apiKey.envVar} environment variable.`);
      } else if (apiKey.source === "file") {
        logger.log(`Your API key is invalid. Run ${commandInstruction("login")} to log in again.`);
      } else {
        logger.log("Your API key is invalid.");
      }
    } else {
      throw error;
    }
  }
}

export function formatUser(user: {name?: string; login: string}): string {
  return user.name ? `${user.name} (@${user.login})` : `@${user.login}`;
}
