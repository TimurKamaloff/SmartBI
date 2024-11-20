import { IWrenAIAdaptor } from '@server/adaptors/wrenAIAdaptor';
import {
  AskResult,
  AskResultStatus,
  AskHistory,
  RecommendationQuestionsResult,
  RecommendationQuestionsInput,
  RecommendationQuestion,
  WrenAIError,
  RecommendationQuestionStatus,
} from '@server/models/adaptor';
import { IDeployService } from './deployService';
import { IProjectService } from './projectService';
import { IThreadRepository, Thread } from '../repositories/threadRepository';
import {
  IThreadResponseRepository,
  ThreadResponse,
  ThreadResponseWithThreadContext,
} from '../repositories/threadResponseRepository';
import { getLogger } from '@server/utils';
import { isEmpty, isNil } from 'lodash';
import { format } from 'sql-formatter';
import {
  PostHogTelemetry,
  TelemetryEvent,
  WrenService,
} from '../telemetry/telemetry';
import { IViewRepository, View } from '../repositories';
import { IQueryService, PreviewDataResponse } from './queryService';
import { IMDLService } from './mdlService';
import { ThreadRecommendQuestionBackgroundTracker } from '../backgrounds';

const logger = getLogger('AskingService');
logger.level = 'debug';

const QUERY_ID_PLACEHOLDER = '0';

export interface Task {
  id: string;
}

export interface AskingPayload {
  threadId?: number;
  language: string;
}

export interface AskingTaskInput {
  question: string;
}

export interface AskingDetailTaskInput {
  question?: string;
  sql?: string;
  viewId?: number;
}

export interface AskingDetailTaskUpdateInput {
  summary?: string;
}

export enum RecommendQuestionResultStatus {
  NOT_STARTED = 'NOT_STARTED',
  GENERATING = 'GENERATING',
  FINISHED = 'FINISHED',
  FAILED = 'FAILED',
}

export interface ThreadRecommendQuestionResult {
  status: RecommendQuestionResultStatus;
  questions: RecommendationQuestion[];
  error?: WrenAIError;
}

export interface InstantRecommendedQuestionsInput {
  previousQuestions?: string[];
}

export interface IAskingService {
  /**
   * Asking task.
   */
  createAskingTask(
    input: AskingTaskInput,
    payload: Pick<AskingPayload, 'threadId' | 'language'>,
  ): Promise<Task>;
  cancelAskingTask(taskId: string): Promise<void>;
  getAskingTask(taskId: string): Promise<AskResult>;

  /**
   * Asking detail task.
   */
  createThread(
    input: AskingDetailTaskInput,
    payload: Pick<AskingPayload, 'language'>,
  ): Promise<Thread>;
  updateThread(
    threadId: number,
    input: Partial<AskingDetailTaskUpdateInput>,
  ): Promise<Thread>;
  deleteThread(threadId: number): Promise<void>;
  listThreads(): Promise<Thread[]>;
  createThreadResponse(
    input: AskingDetailTaskInput,
    payload: Pick<AskingPayload, 'threadId' | 'language'>,
  ): Promise<ThreadResponse>;
  getResponsesWithThread(
    threadId: number,
  ): Promise<ThreadResponseWithThreadContext[]>;
  getResponse(responseId: number): Promise<ThreadResponse>;
  previewData(
    responseId: number,
    stepIndex?: number,
    limit?: number,
  ): Promise<PreviewDataResponse>;

  /**
   * Recommendation questions
   */
  createInstantRecommendedQuestions(
    input: InstantRecommendedQuestionsInput,
  ): Promise<Task>;
  getInstantRecommendedQuestions(
    queryId: string,
  ): Promise<RecommendationQuestionsResult>;
  generateThreadRecommendationQuestions(threadId: number): Promise<void>;
  getThreadRecommendationQuestions(
    threadId: number,
  ): Promise<ThreadRecommendQuestionResult>;

  deleteAllByProjectId(projectId: number): Promise<void>;
}

/**
 * utility function to check if the status is finalized
 */
const isFinalized = (status: AskResultStatus) => {
  return (
    status === AskResultStatus.FAILED ||
    status === AskResultStatus.FINISHED ||
    status === AskResultStatus.STOPPED
  );
};

/**
 * Given a list of steps, construct the SQL statement with CTEs
 * If stepIndex is provided, only construct the SQL from top to that step
 * @param steps
 * @param stepIndex
 * @returns string
 */
export const constructCteSql = (
  steps: Array<{ cteName: string; summary: string; sql: string }>,
  stepIndex?: number,
): string => {
  // validate stepIndex
  if (!isNil(stepIndex) && (stepIndex < 0 || stepIndex >= steps.length)) {
    throw new Error(`Invalid stepIndex: ${stepIndex}`);
  }

  const slicedSteps = isNil(stepIndex) ? steps : steps.slice(0, stepIndex + 1);

  // if there's only one step, return the sql directly
  if (slicedSteps.length === 1) {
    return `-- ${slicedSteps[0].summary}\n${slicedSteps[0].sql}`;
  }

  let sql = 'WITH ';
  slicedSteps.forEach((step, index) => {
    if (index === slicedSteps.length - 1) {
      // if it's the last step, remove the trailing comma.
      // no need to wrap with WITH
      sql += `\n-- ${step.summary}\n`;
      sql += `${step.sql}`;
    } else if (index === slicedSteps.length - 2) {
      // if it's the last two steps, remove the trailing comma.
      // wrap with CTE
      sql += `${step.cteName} AS`;
      sql += `\n-- ${step.summary}\n`;
      sql += `(${step.sql})`;
    } else {
      // if it's not the last step, wrap with CTE
      sql += `${step.cteName} AS`;
      sql += `\n-- ${step.summary}\n`;
      sql += `(${step.sql}),`;
    }
  });

  return sql;
};

/**
 * Background tracker to track the status of the asking detail task
 */
class BackgroundTracker {
  // tasks is a kv pair of task id and thread response
  private tasks: Record<number, ThreadResponse> = {};
  private intervalTime: number;
  private wrenAIAdaptor: IWrenAIAdaptor;
  private threadResponseRepository: IThreadResponseRepository;
  private runningJobs = new Set();
  private telemetry: PostHogTelemetry;

  constructor({
    telemetry,
    wrenAIAdaptor,
    threadResponseRepository,
  }: {
    telemetry: PostHogTelemetry;
    wrenAIAdaptor: IWrenAIAdaptor;
    threadResponseRepository: IThreadResponseRepository;
  }) {
    this.telemetry = telemetry;
    this.wrenAIAdaptor = wrenAIAdaptor;
    this.threadResponseRepository = threadResponseRepository;
    this.intervalTime = 1000;
    this.start();
  }

  public start() {
    logger.info('Background tracker started');
    setInterval(() => {
      const jobs = Object.values(this.tasks).map(
        (threadResponse) => async () => {
          // check if same job is running
          if (this.runningJobs.has(threadResponse.id)) {
            return;
          }

          // mark the job as running
          this.runningJobs.add(threadResponse.id);

          // get the latest result from AI service
          const result = await this.wrenAIAdaptor.getAskDetailResult(
            threadResponse.queryId,
          );

          // check if status change
          if (threadResponse.status === result.status) {
            // mark the job as finished
            logger.debug(
              `Job ${threadResponse.id} status not changed, finished`,
            );
            this.runningJobs.delete(threadResponse.id);
            return;
          }

          // update database
          logger.debug(`Job ${threadResponse.id} status changed, updating`);
          await this.threadResponseRepository.updateOne(threadResponse.id, {
            status: result.status,
            detail: result.response,
            error: result.error,
          });

          // remove the task from tracker if it is finalized
          if (isFinalized(result.status)) {
            const eventProperties = {
              question: threadResponse.question,
              error: result.error,
            };
            if (result.status === AskResultStatus.FINISHED) {
              this.telemetry.sendEvent(
                TelemetryEvent.HOME_ANSWER_QUESTION,
                eventProperties,
              );
            } else {
              this.telemetry.sendEvent(
                TelemetryEvent.HOME_ANSWER_QUESTION,
                eventProperties,
                WrenService.AI,
                false,
              );
            }
            logger.debug(`Job ${threadResponse.id} is finalized, removing`);
            delete this.tasks[threadResponse.id];
          }

          // mark the job as finished
          this.runningJobs.delete(threadResponse.id);
        },
      );

      // run the jobs
      Promise.allSettled(jobs.map((job) => job())).then((results) => {
        // show reason of rejection
        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            logger.error(`Job ${index} failed: ${result.reason}`);
          }
        });
      });
    }, this.intervalTime);
  }

  public addTask(threadResponse: ThreadResponse) {
    this.tasks[threadResponse.id] = threadResponse;
  }

  public getTasks() {
    return this.tasks;
  }
}

export class AskingService implements IAskingService {
  private wrenAIAdaptor: IWrenAIAdaptor;
  private deployService: IDeployService;
  private projectService: IProjectService;
  private viewRepository: IViewRepository;
  private threadRepository: IThreadRepository;
  private threadResponseRepository: IThreadResponseRepository;
  private backgroundTracker: BackgroundTracker;
  private threadRecommendQuestionBackgroundTracker: ThreadRecommendQuestionBackgroundTracker;
  private queryService: IQueryService;
  private telemetry: PostHogTelemetry;
  private mdlService: IMDLService;

  constructor({
    telemetry,
    wrenAIAdaptor,
    deployService,
    projectService,
    viewRepository,
    threadRepository,
    threadResponseRepository,
    queryService,
    mdlService,
  }: {
    telemetry: PostHogTelemetry;
    wrenAIAdaptor: IWrenAIAdaptor;
    deployService: IDeployService;
    projectService: IProjectService;
    viewRepository: IViewRepository;
    threadRepository: IThreadRepository;
    threadResponseRepository: IThreadResponseRepository;
    queryService: IQueryService;
    mdlService: IMDLService;
  }) {
    this.wrenAIAdaptor = wrenAIAdaptor;
    this.deployService = deployService;
    this.projectService = projectService;
    this.viewRepository = viewRepository;
    this.threadRepository = threadRepository;
    this.threadResponseRepository = threadResponseRepository;
    this.telemetry = telemetry;
    this.queryService = queryService;
    this.backgroundTracker = new BackgroundTracker({
      telemetry,
      wrenAIAdaptor,
      threadResponseRepository,
    });
    this.threadRecommendQuestionBackgroundTracker =
      new ThreadRecommendQuestionBackgroundTracker({
        telemetry,
        wrenAIAdaptor,
        threadRepository,
      });

    this.mdlService = mdlService;
  }

  public async getThreadRecommendationQuestions(
    threadId: number,
  ): Promise<ThreadRecommendQuestionResult> {
    const thread = await this.threadRepository.findOneBy({ id: threadId });
    if (!thread) {
      throw new Error(`Thread ${threadId} not found`);
    }

    // handle not started
    const res: ThreadRecommendQuestionResult = {
      status: RecommendQuestionResultStatus.NOT_STARTED,
      questions: [],
      error: null,
    };
    if (thread.queryId && thread.questionsStatus) {
      res.status = RecommendQuestionResultStatus[thread.questionsStatus]
        ? RecommendQuestionResultStatus[thread.questionsStatus]
        : res.status;
      res.questions = thread.questions || [];
      res.error = thread.questionsError as WrenAIError;
    }
    return res;
  }

  public async generateThreadRecommendationQuestions(
    threadId: number,
  ): Promise<void> {
    const thread = await this.threadRepository.findOneBy({ id: threadId });
    if (!thread) {
      throw new Error(`Thread ${threadId} not found`);
    }

    if (this.threadRecommendQuestionBackgroundTracker.isExist(thread)) {
      logger.debug(
        `thread "${threadId}" recommended questions are generating, skip the current request`,
      );
      return;
    }

    const project = await this.projectService.getCurrentProject();
    const { manifest } = await this.mdlService.makeCurrentModelMDL();

    const threadResponses = await this.threadResponseRepository.findAllBy({
      threadId,
    });
    // descending order and get the latest 5
    const slicedThreadResponses = threadResponses
      .sort((a, b) => b.id - a.id)
      .slice(0, 5);
    const questions = slicedThreadResponses.map(({ question }) => question);
    const recommendQuestionData: RecommendationQuestionsInput = {
      manifest,
      previousQuestions: questions,
      projectId: project.id.toString(),
      maxCategories: 3,
      maxQuestions: 9,
      configuration: {
        language: project.language,
      },
    };

    const result = await this.wrenAIAdaptor.generateRecommendationQuestions(
      recommendQuestionData,
    );
    // reset thread recommended questions
    const updatedThread = await this.threadRepository.updateOne(threadId, {
      queryId: result.queryId,
      questionsStatus: RecommendationQuestionStatus.GENERATING,
      questions: [],
      questionsError: null,
    });
    this.threadRecommendQuestionBackgroundTracker.addTask(updatedThread);
    return;
  }

  public async initialize() {
    // list thread responses from database
    // filter status not finalized and put them into background tracker
    const threadResponses = await this.threadResponseRepository.findAll();
    const unfininshedThreadResponses = threadResponses.filter(
      (threadResponse) =>
        !isFinalized(threadResponse.status as AskResultStatus),
    );
    logger.info(
      `Initialization: adding unfininshed thread responses (total: ${unfininshedThreadResponses.length}) to background tracker`,
    );
    for (const threadResponse of unfininshedThreadResponses) {
      this.backgroundTracker.addTask(threadResponse);
    }
  }

  /**
   * Asking task.
   */
  public async createAskingTask(
    input: AskingTaskInput,
    payload: Pick<AskingPayload, 'threadId' | 'language'>,
  ): Promise<Task> {
    const { threadId, language } = payload;
    const deployId = await this.getDeployId();

    // if it's a follow-up question, then the input will have a threadId
    // then use the threadId to get the sql and get the steps of last thread response
    // construct it into AskHistory and pass to ask
    const history: AskHistory = threadId
      ? await this.getHistory(threadId)
      : null;
    const response = await this.wrenAIAdaptor.ask({
      query: input.question,
      history,
      deployId,
      configurations: { language },
    });
    return {
      id: response.queryId,
    };
  }

  public async cancelAskingTask(taskId: string): Promise<void> {
    const eventName = TelemetryEvent.HOME_CANCEL_ASK;
    try {
      await this.wrenAIAdaptor.cancelAsk(taskId);
      this.telemetry.sendEvent(eventName, {});
    } catch (err: any) {
      this.telemetry.sendEvent(eventName, {}, err.extensions?.service, false);
      throw err;
    }
  }

  public async getAskingTask(taskId: string): Promise<AskResult> {
    return this.wrenAIAdaptor.getAskResult(taskId);
  }

  /**
   * Asking detail task.
   * The process of creating a thread is as follows:
   * If input contains a viewId, simply create a thread from saved properties of the view.
   * Otherwise, create a task on AI service to generate the detail.
   * 1. create a task on AI service to generate the detail
   * 2. create a thread and the first thread response
   * 3. put the task into background tracker
   */
  public async createThread(
    input: AskingDetailTaskInput,
    payload: Pick<AskingPayload, 'language'>,
  ): Promise<Thread> {
    const { language } = payload;
    // if input contains a viewId, simply create a thread from saved properties of the view
    if (input.viewId) {
      return this.createThreadFromView(input);
    }

    // 1. create a task on AI service to generate the detail
    const response = await this.wrenAIAdaptor.generateAskDetail({
      query: input.question,
      sql: input.sql,
      configurations: { language },
    });

    // 2. create a thread and the first thread response
    const { id } = await this.projectService.getCurrentProject();
    const thread = await this.threadRepository.createOne({
      projectId: id,
      sql: input.sql,
      summary: input.question,
    });

    const threadResponse = await this.threadResponseRepository.createOne({
      threadId: thread.id,
      queryId: response.queryId,
      question: input.question,
      status: AskResultStatus.UNDERSTANDING,
    });

    // 3. put the task into background tracker
    this.backgroundTracker.addTask(threadResponse);

    // return the task id
    return thread;
  }

  public async listThreads(): Promise<Thread[]> {
    const { id } = await this.projectService.getCurrentProject();
    return await this.threadRepository.listAllTimeDescOrder(id);
  }

  public async updateThread(
    threadId: number,
    input: Partial<AskingDetailTaskUpdateInput>,
  ): Promise<Thread> {
    // if input is empty, throw error
    if (isEmpty(input)) {
      throw new Error('Update thread input is empty');
    }

    return this.threadRepository.updateOne(threadId, {
      summary: input.summary,
    });
  }

  public async deleteThread(threadId: number): Promise<void> {
    await this.threadRepository.deleteOne(threadId);
  }

  public async createThreadResponse(
    input: AskingDetailTaskInput,
    payload: AskingPayload,
  ): Promise<ThreadResponse> {
    const { threadId, language } = payload;
    const thread = await this.threadRepository.findOneBy({
      id: threadId,
    });

    if (!thread) {
      throw new Error(`Thread ${threadId} not found`);
    }

    // if input contains a viewId, simply create a thread from saved properties of the view
    if (input.viewId) {
      const view = await this.viewRepository.findOneBy({ id: input.viewId });

      if (!view) {
        throw new Error(`View ${input.viewId} not found`);
      }

      const res = await this.createThreadResponseFromView(input, view, thread);
      return res;
    }

    // 1. create a task on AI service to generate the detail
    const response = await this.wrenAIAdaptor.generateAskDetail({
      query: input.question,
      sql: input.sql,
      configurations: { language },
    });

    // 2. create a thread and the first thread response
    // insert question first, another API  all the asked questions to generate the next recommendation questions
    const threadResponse = await this.threadResponseRepository.createOne({
      threadId: thread.id,
      queryId: response.queryId,
      question: input.question,
      status: AskResultStatus.UNDERSTANDING,
    });

    // 3. put the task into background tracker
    this.backgroundTracker.addTask(threadResponse);

    // return the task id
    return threadResponse;
  }

  public async getResponsesWithThread(threadId: number) {
    return this.threadResponseRepository.getResponsesWithThread(threadId);
  }

  public async getResponse(responseId: number) {
    return this.threadResponseRepository.findOneBy({ id: responseId });
  }

  /**
   * this function is used to preview the data of a thread response
   * get the target thread response and get the steps
   * construct the CTEs and get the data
   * @param responseId
   * @param stepIndex
   * @returns Promise<QueryResponse>
   */
  public async previewData(
    responseId: number,
    stepIndex?: number,
    limit?: number,
  ): Promise<PreviewDataResponse> {
    const response = await this.getResponse(responseId);
    if (!response) {
      throw new Error(`Thread response ${responseId} not found`);
    }
    const project = await this.projectService.getCurrentProject();
    const deployment = await this.deployService.getLastDeployment(project.id);
    const mdl = deployment.manifest;
    const steps = response.detail.steps;
    const sql = format(constructCteSql(steps, stepIndex));
    const eventName = TelemetryEvent.HOME_PREVIEW_ANSWER;
    try {
      const data = (await this.queryService.preview(sql, {
        project,
        manifest: mdl,
        limit,
      })) as PreviewDataResponse;
      this.telemetry.sendEvent(eventName, { sql });
      return data;
    } catch (err: any) {
      this.telemetry.sendEvent(
        eventName,
        { sql, error: err.message },
        err.extensions?.service,
        false,
      );
      throw err;
    }
  }

  public async createInstantRecommendedQuestions(
    input: InstantRecommendedQuestionsInput,
  ): Promise<Task> {
    const project = await this.projectService.getCurrentProject();
    const { manifest } = await this.deployService.getLastDeployment(project.id);

    const response = await this.wrenAIAdaptor.generateRecommendationQuestions({
      manifest,
      projectId: project.id.toString(),
      previousQuestions: input.previousQuestions,
      maxCategories: 3,
      maxQuestions: 3,
      configuration: { language: project.language },
    });
    return { id: response.queryId };
  }

  public async getInstantRecommendedQuestions(
    queryId: string,
  ): Promise<RecommendationQuestionsResult> {
    const response =
      await this.wrenAIAdaptor.getRecommendationQuestionsResult(queryId);
    return response;
  }

  public async deleteAllByProjectId(projectId: number): Promise<void> {
    // delete all threads
    await this.threadRepository.deleteAllBy({ projectId });
  }

  private async getDeployId() {
    const { id } = await this.projectService.getCurrentProject();
    const lastDeploy = await this.deployService.getLastDeployment(id);
    return lastDeploy.hash;
  }

  /**
   * Get the thread with threadId & latest thread response of a thread
   * transform the response into AskHistory
   * @param threadId
   * @returns Promise<AskHistory>
   */
  private async getHistory(threadId: number): Promise<AskHistory> {
    const responses =
      await this.threadResponseRepository.getResponsesWithThread(threadId, 1);
    if (!responses.length) {
      return null;
    }

    const latestResponse = responses[0];
    return {
      sql: latestResponse.sql,
      steps: latestResponse.detail.steps,
    };
  }

  private async createThreadFromView(input: AskingDetailTaskInput) {
    const view = await this.viewRepository.findOneBy({ id: input.viewId });
    if (!view) {
      throw new Error(`View ${input.viewId} not found`);
    }

    const { id } = await this.projectService.getCurrentProject();
    const thread = await this.threadRepository.createOne({
      projectId: id,
      sql: view.statement,
      summary: input.question,
    });

    await this.createThreadResponseFromView(input, view, thread);
    return thread;
  }

  private async createThreadResponseFromView(
    input: AskingDetailTaskInput,
    view: View,
    thread: Thread,
  ) {
    const properties = JSON.parse(view.properties) || {};
    return this.threadResponseRepository.createOne({
      threadId: thread.id,
      queryId: QUERY_ID_PLACEHOLDER,
      question: input.question,
      status: AskResultStatus.FINISHED,
      detail: {
        ...properties.detail,
        viewId: view.id,
      },
    });
  }
}
