// Request types
export type ListCollectionsRequest = {
  page?: number;
};

export type GetCollectionRequest = {
  collectionId: string;
  withDatasetMetadata?: boolean;
};

export type ListDatasetsRequest = {
  page?: number;
};

export type GetDatasetMetadataRequest = {
  datasetId: string;
};

export type SearchDatasetRequest = {
  resource_id: string;
  limit?: number;
  offset?: number;
  fields?: string;
  q?: string;
  sort?: string;
};

export type InitiateDownloadRequest = {
  datasetId: string;
  columnNames?: string[];
  filters?: {
    columnName: string;
    type: 'EQ' | 'LIKE' | 'ILIKE';
    value?: any;
  }[];
};

export type PollDownloadRequest = {
  datasetId: string;
  columnNames?: string[];
  filters?: {
    columnName: string;
    type: 'EQ' | 'LIKE' | 'ILIKE';
    value?: any;
  }[];
};

// API wrapper types
export type ApiResponse<T> = {
  data?: T;
  errorMsg?: string;
};

// Response types
export type ListCollectionsResponse = {
  collections: {
    collectionId: string;
    createdAt: string;
    name: string;
    description: string;
    lastUpdatedAt: string;
    frequency: string;
    sources: string[];
    managedByAgencyName: string;
    childDatasets: string[];
    coverageStart?: string;
    coverageEnd?: string;
  }[];
  pages: number;
};

export type GetCollectionResponse = {
  collectionMetadata: {
    collectionId: string;
    createdAt: string;
    name: string;
    description: string;
    lastUpdatedAt: string;
    frequency: string;
    sources: string[];
    managedBy: string;
    childDatasets: string[];
  };
};

export type ListDatasetsResponse = {
  datasets: {
    datasetId: string;
    createdAt: string;
    name: string;
    status: string;
    format: string;
    lastUpdatedAt: string;
    managedByAgencyName: string;
    description?: string;
    coverageStart?: string;
    coverageEnd?: string;
  }[];
  pages: number;
  rowCount: number;
  totalRowCount: number;
};

export type GetDatasetMetadataResponse = {
  datasetId: string;
  createdAt: string;
  name: string;
  collectionIds: string[];
  format: string;
  lastUpdatedAt: string;
  managedBy: string;
  datasetSize: number;
  geoJsonMetadata: {
    properties: {
      dataType: {
        label: string;
        value: string;
      };
      attribute: string;
      description: string;
    }[];
  };
};

export type SearchDatasetResponse = {
  error?: string;
};

export type InitiateDownloadResponse = {
  message: string;
  url: string;
};

export type PollDownloadResponse = {
  url: string;
};
