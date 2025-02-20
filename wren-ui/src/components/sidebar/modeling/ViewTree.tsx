import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Modal } from 'antd';
import { DataNode } from 'antd/es/tree';
import PlusOutlined from '@ant-design/icons/PlusOutlined';
import { Path } from '@/utils/enum';
import { DiagramView } from '@/utils/data';
import { getNodeTypeIcon } from '@/utils/nodeType';
import {
  createTreeGroupNode,
  getColumnNode,
  GroupActionButton,
} from '@/components/sidebar/utils';
import LabelTitle from '@/components/sidebar/LabelTitle';
import { StyledSidebarTree } from '@/components/sidebar/Modeling';

interface Props {
  [key: string]: any;
  views: DiagramView[];
}

export default function ViewTree(props: Props) {
  const { views } = props;

  const onAddView = () => {
    Modal.info({
      title: 'Как создать представление?',
      content: (
        <div>
          Задавайте свои вопросы на{' '}
          <Link
            href={Path.Home}
            data-ph-capture="true"
            data-ph-capture-attribute-name="cta_add_view_navigate_to_home"
          >
            главной странице
          </Link>
          и получайте полезные ответы, которые можно сохранить в качестве
          представлений.
        </div>
      ),
      okButtonProps: {
        ['data-ph-capture']: true,
        ['data-ph-capture-attribute-name']: 'cta_add_view_ok_btn',
      } as any,
    });
  };

  const getViewGroupNode = createTreeGroupNode({
    groupName: 'Представления',
    groupKey: 'views',
    actions: [
      {
        key: 'add-view-info',
        render: () => (
          <GroupActionButton
            icon={<PlusOutlined />}
            size="small"
            onClick={onAddView}
            data-ph-capture="true"
            data-ph-capture-attribute-name="cta_add_view"
          >
            Добавить
          </GroupActionButton>
        ),
      },
    ],
  });

  const [tree, setTree] = useState<DataNode[]>(getViewGroupNode());

  useEffect(() => {
    setTree((_tree) =>
      getViewGroupNode({
        quotaUsage: views.length,
        children: views.map((view) => {
          const nodeKey = view.id;
          const children = getColumnNode(nodeKey, view.fields || []);

          return {
            children,
            className: 'adm-treeNode',
            icon: getNodeTypeIcon({ nodeType: view.nodeType }),
            id: nodeKey,
            isLeaf: false,
            key: nodeKey,
            title: <LabelTitle title={view.displayName} />,
            type: view.nodeType,
          };
        }),
      }),
    );
  }, [views]);

  return <StyledSidebarTree {...props} treeData={tree} />;
}
