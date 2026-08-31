import { initialFilePatchTool } from '../tools/file-patch.js';
import { initialMessageTool } from '../tools/message.js';
import { initialSelectionTool } from '../tools/select-tool-action.js';
import { initialConsequenceTool } from '../tools/attend-consequence.js';
import { initialEncounterShapeTool } from '../tools/shape-encounter.js';
import { initialDependencyTool } from '../tools/manage-dependency.js';
import { initialScheduleWakeTool } from '../tools/schedule-wake.js';
import { initialReadFileTool } from '../tools/read-file.js';
import { initialWriteFileTool } from '../tools/write-file.js';
import { initialSearchFilesTool } from '../tools/search-files.js';
import { initialShellTool } from '../tools/shell.js';
import { initialWebFetchTool } from '../tools/web-fetch.js';

export function initialTools() {
  return [
    initialMessageTool(), initialFilePatchTool(), initialSelectionTool(), initialConsequenceTool(),
    initialEncounterShapeTool(), initialDependencyTool(),
    initialScheduleWakeTool(),
    initialReadFileTool(), initialWriteFileTool(), initialSearchFilesTool(),
    initialShellTool(), initialWebFetchTool(),
  ];
}
