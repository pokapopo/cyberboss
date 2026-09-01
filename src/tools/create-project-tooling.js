const { createWeixinChannelAdapter } = require("../adapters/channel/weixin");
const { SessionStore } = require("../adapters/runtime/codex/session-store");
const { createTimelineIntegration } = require("../integrations/timeline");
const { ExperienceStore } = require("../core/experience-store");
const { WorkLogStore } = require("../core/work-log-store");
const { BackgroundContinuityStore } = require("../core/background-continuity-store");
const { ChannelFileService } = require("../services/channel-file-service");
const { DiaryService } = require("../services/diary-service");
const { ReminderService } = require("../services/reminder-service");
const { StickerService } = require("../services/sticker-service");
const { SystemMessageService } = require("../services/system-message-service");
const { TimelineService } = require("../services/timeline-service");
const { RuntimeContextStore } = require("./runtime-context-store");
const { ProjectToolHost } = require("./tool-host");
const { WhereaboutsService } = require("whereabouts-mcp");
const { NcpReadOnlyAdapter } = require("../integrations/ncp-readonly");
const { NcpNativeAdapter } = require("../integrations/ncp-native");
const { OmbreCoreAdapter } = require("../integrations/ombre-core");

function createProjectTooling(config, options = {}) {
  const ncpNativeMode = options.ncpNativeMode || process.env.CYBERBOSS_NCP_NATIVE || "off";
  const sessionStore = options.sessionStore || new SessionStore({
    filePath: config.sessionsFile,
    runtimeId: config.runtime || "codex",
  });
  const channelAdapter = options.channelAdapter || createWeixinChannelAdapter(config);
  const timelineIntegration = options.timelineIntegration || createTimelineIntegration(config);
  const runtimeContextStore = options.runtimeContextStore || new RuntimeContextStore({
    filePath: config.projectToolContextFile,
  });
  const channelFile = new ChannelFileService({ config, channelAdapter, sessionStore });
  const services = {
    backgroundContinuity: options.backgroundContinuityStore || new BackgroundContinuityStore({ filePath: config.backgroundContinuityFile }),
    workLog: options.workLogStore || new WorkLogStore({
      filePath: config.workLogFile,
    }),
    experience: options.experienceStore || new ExperienceStore({
      filePath: config.experienceFile,
    }),
    diary: new DiaryService({ config }),
    reminder: new ReminderService({ config, sessionStore }),
    system: new SystemMessageService({ config, sessionStore }),
    channelFile,
    sticker: new StickerService({ config, channelAdapter, sessionStore, channelFileService: channelFile }),
    timeline: new TimelineService({ config, timelineIntegration, sessionStore }),
    ncpReadOnly: options.ncpReadOnly || new NcpReadOnlyAdapter({ cwd: config.workspaceRoot }),
    ncpNative: options.ncpNative || new NcpNativeAdapter({ cwd: config.workspaceRoot, mode: ncpNativeMode }),
    ncpNativeEnabled: ["read-only", "guarded-write"].includes(ncpNativeMode),
    ombreCore: options.ombreCore || new OmbreCoreAdapter({ cwd: config.workspaceRoot }),
    whereabouts: new WhereaboutsService({
      config: {
        storeFile: config.locationStoreFile,
        host: config.locationHost,
        port: config.locationPort,
        token: config.locationToken,
        historyLimit: config.locationHistoryLimit,
        movementEventLimit: config.locationMovementEventLimit,
        batteryHistoryLimit: config.locationBatteryHistoryLimit,
        knownPlaces: config.locationKnownPlaces,
        knownPlaceRadiusMeters: config.locationKnownPlaceRadiusMeters,
        stayMergeRadiusMeters: config.locationStayMergeRadiusMeters,
        stayBreakConfirmRadiusMeters: config.locationStayBreakConfirmRadiusMeters,
        stayBreakConfirmSamples: config.locationStayBreakConfirmSamples,
        majorMoveThresholdMeters: config.locationMajorMoveThresholdMeters,
      },
    }),
  };
  const toolHost = new ProjectToolHost({
    services,
    runtimeContextStore,
    surface: options.toolSurface || "legacy",
  });
  return {
    services,
    toolHost,
    runtimeContextStore,
  };
}

module.exports = { createProjectTooling };
