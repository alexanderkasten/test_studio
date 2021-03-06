import {EventAggregator, Subscription} from 'aurelia-event-aggregator';
import {bindable, inject, observable} from 'aurelia-framework';

import * as Bluebird from 'bluebird';

import {IShape} from '@process-engine/bpmn-elements_contracts';
import {DataModels} from '@process-engine/management_api_contracts';
import {IDiagram} from '@process-engine/solutionexplorer.contracts';

import {IEventFunction, ISolutionEntry, InspectPanelTab, NotificationType} from '../../../contracts/index';
import environment from '../../../environment';
import {IInspectCorrelationService} from './contracts';
import {DiagramViewer} from './components/diagram-viewer/diagram-viewer';
import {InspectPanel} from './components/inspect-panel/inspect-panel';
import {DEFAULT_PAGESIZE} from './components/inspect-panel/components/correlation-list/correlation-list';
import {NotificationService} from '../../../services/notification-service/notification.service';

@inject('InspectCorrelationService', EventAggregator, 'NotificationService')
export class InspectCorrelation {
  @bindable public processInstanceIdToSelect: string;
  @bindable public processInstanceToSelect: DataModels.Correlations.ProcessInstance;
  @bindable public flowNodeToSelect: string;
  @bindable public activeDiagram: IDiagram;
  @bindable public activeSolutionEntry: ISolutionEntry;
  @bindable public selectedProcessInstance: DataModels.Correlations.ProcessInstance;
  @bindable public inspectPanelFullscreen: boolean = false;
  @observable public bottomPanelHeight: number = 250;
  @observable public tokenViewerWidth: number = 250;
  @bindable public diagramViewer: DiagramViewer;
  @bindable public inspectPanel: InspectPanel;
  @bindable public inspectPanelTabToShow: InspectPanelTab;
  @bindable public totalCount: number;

  public offset: number = 0;
  public limit: number = DEFAULT_PAGESIZE;

  public processInstances: Array<DataModels.Correlations.ProcessInstance>;
  public token: string;
  public showInspectPanel: boolean = true;
  public showTokenViewer: boolean = false;
  public bottomPanelResizeDiv: HTMLDivElement;
  public rightPanelResizeDiv: HTMLDivElement;
  public selectedFlowNode: IShape;

  public viewIsAttached: boolean = false;

  private inspectCorrelationService: IInspectCorrelationService;
  private eventAggregator: EventAggregator;
  private notificationService: NotificationService;
  private subscriptions: Array<Subscription>;

  private updatePromise: any;

  constructor(
    inspectCorrelationService: IInspectCorrelationService,
    eventAggregator: EventAggregator,
    notificationService: NotificationService,
  ) {
    this.inspectCorrelationService = inspectCorrelationService;
    this.eventAggregator = eventAggregator;
    this.notificationService = notificationService;
  }

  public async attached(): Promise<void> {
    this.updateProcessInstances();

    this.eventAggregator.publish(environment.events.statusBar.showInspectCorrelationButtons, true);

    this.subscriptions = [
      this.eventAggregator.subscribe(
        environment.events.inspectCorrelation.showInspectPanel,
        (showInspectPanel: boolean) => {
          this.showInspectPanel = showInspectPanel;
        },
      ),
      this.eventAggregator.subscribe(
        environment.events.inspectCorrelation.showTokenViewer,
        (showTokenViewer: boolean) => {
          this.showTokenViewer = showTokenViewer;
        },
      ),

      this.eventAggregator.subscribe(environment.events.inspectCorrelation.updateProcessInstances, async (payload) => {
        const {offset, limit} = payload;
        this.offset = offset;
        this.limit = limit;

        await this.updateProcessInstances();
      }),
    ];

    this.bottomPanelResizeDiv.addEventListener('mousedown', (mouseDownEvent: Event) => {
      const windowEvent: Event = mouseDownEvent || window.event;
      windowEvent.cancelBubble = true;

      const mousemoveFunction: IEventFunction = (mouseMoveEvent: MouseEvent): void => {
        this.resizeInspectPanel(mouseMoveEvent);
        document.getSelection().empty();
      };

      const mouseUpFunction: IEventFunction = (): void => {
        document.removeEventListener('mousemove', mousemoveFunction);
        document.removeEventListener('mouseup', mouseUpFunction);
      };

      document.addEventListener('mousemove', mousemoveFunction);
      document.addEventListener('mouseup', mouseUpFunction);
    });

    this.rightPanelResizeDiv.addEventListener('mousedown', (mouseDownEvent: Event) => {
      const windowEvent: Event = mouseDownEvent || window.event;
      windowEvent.cancelBubble = true;

      const mousemoveFunction: IEventFunction = (mouseMoveEvent: MouseEvent): void => {
        this.resizeTokenViewer(mouseMoveEvent);
        document.getSelection().empty();
      };

      const mouseUpFunction: IEventFunction = (): void => {
        document.removeEventListener('mousemove', mousemoveFunction);
        document.removeEventListener('mouseup', mouseUpFunction);
      };

      document.addEventListener('mousemove', mousemoveFunction);
      document.addEventListener('mouseup', mouseUpFunction);
    });

    this.viewIsAttached = true;

    const previousTokenViewerState: boolean = JSON.parse(
      window.localStorage.getItem('tokenViewerInspectCollapseState'),
    );
    this.showTokenViewer = previousTokenViewerState || false;

    const flowNodeToSelectExists: boolean = this.flowNodeToSelect !== undefined;
    if (flowNodeToSelectExists) {
      this.diagramViewer.selectFlowNode(this.flowNodeToSelect);
    }

    const shouldDisplaySpecificInspectPanelTab: boolean = this.inspectPanelTabToShow !== undefined;
    if (shouldDisplaySpecificInspectPanelTab) {
      this.inspectPanel.changeTab(this.inspectPanelTabToShow);
    }
  }

  private async updateProcessInstances(): Promise<void> {
    if (this.processInstanceIdToSelect) {
      try {
        this.processInstanceToSelect = await this.inspectCorrelationService.getProcessInstanceById(
          this.activeSolutionEntry.identity,
          this.processInstanceIdToSelect,
          this.activeDiagram.id,
        );
      } catch (error) {
        this.notificationService.showNotification(
          NotificationType.ERROR,
          'The requested ProcessInstance to select could not be found.',
        );
      }
    }

    let processInstanceList;

    try {
      processInstanceList = await this.getProcessInstancesForProcessModel();
    } catch (error) {
      this.eventAggregator.publish(environment.events.inspectCorrelation.noCorrelationsFound, true);
      this.processInstances = [];
      this.totalCount = 0;
    }

    // https://github.com/process-engine/process_engine_runtime/issues/432
    if (processInstanceList && processInstanceList.totalCount === 0) {
      this.eventAggregator.publish(environment.events.inspectCorrelation.noCorrelationsFound, true);
      this.processInstances = [];
    } else if (processInstanceList) {
      this.processInstances = processInstanceList.processInstances;
      this.totalCount = processInstanceList.totalCount;
    }
  }

  private getProcessInstancesForProcessModel(): Promise<DataModels.Correlations.ProcessInstanceList> {
    if (this.updatePromise) {
      this.updatePromise.cancel();
    }

    this.updatePromise = new Bluebird.Promise(
      async (resolve: Function, reject: Function): Promise<any> => {
        try {
          const processInstances = await this.inspectCorrelationService.getProcessInstancesForProcessModel(
            this.activeSolutionEntry.identity,
            this.activeDiagram.id,
            this.offset,
            this.limit,
          );

          resolve(processInstances);
        } catch (error) {
          reject(error);
        }
      },
    );

    return this.updatePromise;
  }

  public detached(): void {
    this.eventAggregator.publish(environment.events.statusBar.showInspectCorrelationButtons, false);

    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  public async activeDiagramChanged(): Promise<void> {
    if (this.viewIsAttached) {
      this.offset = 0;
      this.limit = DEFAULT_PAGESIZE;
      this.processInstanceIdToSelect = undefined;
      this.processInstanceToSelect = undefined;

      this.updateProcessInstances();
    }
  }

  private resizeInspectPanel(mouseEvent: MouseEvent): void {
    const mouseYPosition: number = mouseEvent.clientY;

    const menuBarHeight: number = 40;
    const inspectCorrelation: HTMLElement = this.bottomPanelResizeDiv.parentElement.parentElement;
    const inspectPanelHeightWithStatusBar: number = inspectCorrelation.clientHeight + menuBarHeight;

    const minInspectPanelHeight: number = 250;

    const newBottomPanelHeight: number = inspectPanelHeightWithStatusBar - mouseYPosition;

    this.bottomPanelHeight = Math.max(newBottomPanelHeight, minInspectPanelHeight);
  }

  private resizeTokenViewer(mouseEvent: MouseEvent): void {
    const mouseXPosition: number = mouseEvent.clientX;

    const inspectCorrelation: HTMLElement = this.bottomPanelResizeDiv.parentElement.parentElement;
    const minSpaceForDiagramViewer: number = 300;

    const windowWidth: number = window.innerWidth;
    const rightToolbarWidth: number = 36;

    const minTokenViewerWidth: number = 250;
    const maxTokenViewerWidth: number = inspectCorrelation.clientWidth - minSpaceForDiagramViewer;

    const newTokenViewerWidth: number = windowWidth - mouseXPosition - rightToolbarWidth;

    /*
     * This sets the new width of the token viewer to the minimum or maximum width,
     * if the new width is smaller than the minimum or bigger than the maximum width.
     */
    this.tokenViewerWidth = Math.min(maxTokenViewerWidth, Math.max(newTokenViewerWidth, minTokenViewerWidth));
  }
}
