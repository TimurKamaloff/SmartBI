import { useMemo } from 'react';
import { keyBy } from 'lodash';
import { Col, Row, Typography, Button } from 'antd';
import FieldTable from '@/components/table/FieldTable';
import CalculatedFieldTable from '@/components/table/CalculatedFieldTable';
import RelationTable from '@/components/table/RelationTable';
import PreviewData from '@/components/dataPreview/PreviewData';
import { DiagramModel } from '@/utils/data';
import { usePreviewModelDataMutation } from '@/apollo/client/graphql/model.generated';

export type Props = DiagramModel;

export default function ModelMetadata(props: Props) {
  const {
    modelId,
    displayName,
    referenceName,
    fields = [],
    calculatedFields = [],
    relationFields = [],
    description,
  } = props || {};

  const [previewModelData, previewModelDataResult] =
    usePreviewModelDataMutation({
      onError: (error) => console.error(error),
    });

  // Model preview data should show alias as column name.
  const fieldsMap = useMemo(() => keyBy(fields, 'referenceName'), [fields]);
  const previewData = useMemo(() => {
    const previewModelData = previewModelDataResult.data?.previewModelData;
    const columns = (previewModelData?.columns || []).map((column) => {
      const alias = fieldsMap[column.name]?.displayName;
      return { ...column, name: alias || column.name };
    });
    return { ...previewModelData, columns };
  }, [fieldsMap, previewModelDataResult.data]);

  const onPreviewData = () => {
    previewModelData({ variables: { where: { id: modelId } } });
  };

  return (
    <>
      <Row className="mb-6">
        <Col span={12} data-testid="metadata__name">
          <Typography.Text className="d-block gray-7 mb-2">Имя</Typography.Text>
          <div>{referenceName || '-'}</div>
        </Col>
        <Col span={12} data-testid="metadata__alias">
          <Typography.Text className="d-block gray-7 mb-2">
            Псевдоним
          </Typography.Text>
          <div>{displayName || '-'}</div>
        </Col>
      </Row>
      <div className="mb-6" data-testid="metadata__description">
        <Typography.Text className="d-block gray-7 mb-2">
          Описание
        </Typography.Text>
        <div>{description || '-'}</div>
      </div>

      <div className="mb-6" data-testid="metadata__columns">
        <Typography.Text className="d-block gray-7 mb-2">
          Столбцы ({fields.length})
        </Typography.Text>
        <FieldTable dataSource={fields} showExpandable />
      </div>

      {!!calculatedFields.length && (
        <div className="mb-6" data-testid="metadata__calculated-fields">
          <Typography.Text className="d-block gray-7 mb-2">
            Вычисляемые поля ({calculatedFields.length})
          </Typography.Text>
          <CalculatedFieldTable dataSource={calculatedFields} showExpandable />
        </div>
      )}

      {!!relationFields.length && (
        <div className="mb-6" data-testid="metadata__relationships">
          <Typography.Text className="d-block gray-7 mb-2">
            Связи ({relationFields.length})
          </Typography.Text>
          <RelationTable dataSource={relationFields} showExpandable />
        </div>
      )}

      <div className="mb-6" data-testid="metadata__preview-data">
        <Typography.Text className="d-block gray-7 mb-2">
          Предварительный просмотр данных (100 строк)
        </Typography.Text>
        <Button
          onClick={onPreviewData}
          loading={previewModelDataResult.loading}
        >
          Предварительный просмотр данных
        </Button>
        <div className="my-3">
          <PreviewData
            error={previewModelDataResult.error}
            loading={previewModelDataResult.loading}
            previewData={previewData}
          />
        </div>
      </div>
    </>
  );
}
