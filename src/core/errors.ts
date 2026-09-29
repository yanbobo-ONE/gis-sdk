/** SDK 可稳定判断的错误代码。 */
export type GisErrorCode =
  | 'BASEMAP_LOAD_FAILED'
  | 'CAMERA_FLIGHT_CANCELLED'
  | 'CESIUM_BASE_URL_CONFLICT'
  | 'DATA_PIPELINE_CLOSED'
  | 'DATA_PIPELINE_FRAME_SCHEDULER_DISPOSED'
  | 'DATA_PIPELINE_FRAME_SCHEDULER_UNAVAILABLE'
  | 'DATA_PIPELINE_MESSAGE_ADAPTER_DISPOSED'
  | 'DUPLICATE_LAYER_ID'
  | 'EVENT_LISTENER_FAILED'
  | 'INVALID_CONTAINER'
  | 'INVALID_CAMERA_VIEW'
  | 'INVALID_COORDINATES'
  | 'INVALID_QUALITY_CONFIG'
  | 'INVALID_REALTIME_CONFIG'
  | 'INVALID_REALTIME_INPUT'
  | 'INVALID_SCENE_CONFIG'
  | 'INVALID_PICKING_CONFIG'
  | 'INVALID_CRS_DEFINITION'
  | 'INVALID_CSV_INPUT'
  | 'INVALID_DRAWING_INPUT'
  | 'INVALID_SPATIAL_INPUT'
  | 'INVALID_BASEMAP_CONFIG'
  | 'INVALID_BASEMAP_OPACITY'
  | 'INVALID_DATA_PIPELINE_CONFIG'
  | 'INVALID_DATA_PIPELINE_FRAME_SCHEDULER_CONFIG'
  | 'INVALID_DATA_PIPELINE_KEY'
  | 'INVALID_DATA_PIPELINE_MESSAGE_ADAPTER_CONFIG'
  | 'INVALID_DATA_PIPELINE_TAKE_LIMIT'
  | 'INVALID_LAYER_ID'
  | 'INVALID_LAYER_STYLE'
  | 'INVALID_LAYER_COLOR'
  | 'INVALID_LAYER_CONFIG'
  | 'INVALID_LAYER_OPACITY'
  | 'INVALID_MODEL_LOAD_CONFIG'
  | 'INVALID_WMS_FILTER'
  | 'INVALID_WMS_PARAMETERS'
  | 'LAYER_BUSY'
  | 'LAYER_CLEAR_FAILED'
  | 'LAYER_DISPOSED'
  | 'LAYER_DISPOSE_FAILED'
  | 'LAYER_LOAD_FAILED'
  | 'LAYER_MANAGER_BUSY'
  | 'LAYER_MANAGER_DISPOSED'
  | 'LAYER_OPERATION_ABORTED'
  | 'MAP_DISPOSED'
  | 'MAP_DESTROY_FAILED'
  | 'INVALID_TERRAIN_CONFIG'
  | 'TERRAIN_BUSY'
  | 'TERRAIN_DISPOSED'
  | 'TERRAIN_LOAD_FAILED'
  | 'TERRAIN_SAMPLING_ABORTED'
  | 'TERRAIN_SAMPLING_FAILED'
  | 'SCENE_MORPH_SUPERSEDED'
  | 'TERRAIN_SAMPLING_UNAVAILABLE'
  | 'UNSUPPORTED_CRS';

/** 创建 {@link GisError} 所需的结构化上下文。 */
export interface GisErrorOptions {
  /** 稳定错误代码。 */
  readonly code: GisErrorCode;
  /** 发生错误的 SDK 模块。 */
  readonly module: string;
  /** 发生错误的具体操作。 */
  readonly operation: string;
  /** 调用方是否可以重试，默认 `false`。 */
  readonly retryable?: boolean;
  /** 原始异常或失败值。 */
  readonly cause?: unknown;
}

/** SDK 操作失败时抛出的结构化错误。 */
export class GisError extends Error {
  /** 供业务分支判断的稳定错误代码。 */
  readonly code: GisErrorCode;
  /** 发生错误的 SDK 模块。 */
  readonly module: string;
  /** 发生错误的具体操作。 */
  readonly operation: string;
  /** 当前操作是否允许由调用方重试。 */
  readonly retryable: boolean;

  /** 创建结构化 SDK 错误。 */
  constructor(message: string, options: GisErrorOptions) {
    super(message, { cause: options.cause });
    this.name = 'GisError';
    this.code = options.code;
    this.module = options.module;
    this.operation = options.operation;
    this.retryable = options.retryable ?? false;
  }
}
