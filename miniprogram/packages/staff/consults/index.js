const {createPage}=require('../../../utils/page');
const {listPage}=require('../../../utils/customer-request-page');
createPage(listPage(true));
