import type { PersonalRepository } from "../storage/personal-repository.js";
import type { ProjectRepository } from "../storage/project-repository.js";
import { capabilityHistory } from "./capability-history.js";
import { assessQuality } from "./quality.js";
import { deriveDueQueue, RecallService, type RecallInput } from "./recall.js";
import { recommendGrowth, type GrowthRecommendationInput } from "./recommendation.js";
import { buildGrowthReport, type GrowthReportOptions } from "./report.js";
import { GrowthRepository } from "./repository.js";

/** Local orchestration only: pure reads share one consistent snapshot and clock. */
export class GrowthService {
  private readonly repository: GrowthRepository;
  private readonly recall: RecallService;

  constructor(projectRepository: ProjectRepository, personalRepository: PersonalRepository, private readonly options: { clock: () => Date; id: () => string }) {
    this.repository = new GrowthRepository(projectRepository, personalRepository, options);
    this.recall = new RecallService(this.repository, options);
  }

  async quality(conceptId?: string) {
    const { snapshot } = await this.read();
    return assessQuality(snapshot, conceptId);
  }

  async recommend(input: GrowthRecommendationInput) {
    const { snapshot, now } = await this.read();
    return recommendGrowth(snapshot, input, now);
  }

  capture() { return this.repository.capture(); }

  async due() {
    const { snapshot, now } = await this.read();
    return deriveDueQueue(snapshot, now).filter((item) => item.isDue);
  }

  record(input: RecallInput) { return this.recall.record(input); }

  async history(conceptId?: string) {
    const { snapshot } = await this.read();
    return capabilityHistory(snapshot, conceptId);
  }

  async report(options: GrowthReportOptions = {}) {
    const { snapshot, now } = await this.read();
    return buildGrowthReport(snapshot, options, now);
  }

  private async read() {
    const snapshot = await this.repository.readSnapshot();
    return { snapshot, now: this.options.clock() };
  }
}
