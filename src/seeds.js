import { initialFilePatchTool } from '../tools/file-patch.js';
import { initialMessageTool } from '../tools/message.js';
import { initialSelectionTool } from '../tools/select-tool-action.js';
import { initialConsequenceTool } from '../tools/attend-consequence.js';
import { initialEncounterShapeTool } from '../tools/shape-encounter.js';
import { initialDependencyTool } from '../tools/manage-dependency.js';

export function initialTools() {
  return [
    initialMessageTool(), initialFilePatchTool(), initialSelectionTool(), initialConsequenceTool(),
    initialEncounterShapeTool(), initialDependencyTool(),
  ];
}
